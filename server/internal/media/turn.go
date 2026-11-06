// SPDX-License-Identifier: AGPL-3.0-only
package media

import (
	"context"
	"crypto/fips140"
	"crypto/tls"
	"errors"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/stun/v4"
	"github.com/pion/turn/v5"
)

const turnRealm = "cenacle-media"

type TURNConfig struct {
	Secret, Certificate, PrivateKey string
	MinPort, MaxPort                uint16
	MaxAllocations                  int
	UDPAddr, TLSAddr                string
}
type turnRuntime struct {
	engine      *SFU
	cfg         TURNConfig
	server      *turn.Server
	udp         net.PacketConn
	tlsListener net.Listener
	base        *turn.RelayAddressGeneratorPortRange
	target      netip.AddrPort
	mu          sync.Mutex
	relays      map[*relayConn]bool
	counts      map[string]int
	connections map[string]*turnTLSConnection
	closed      bool
}
type turnTLSConnection struct {
	conn      net.Conn
	allocated atomic.Bool
}

func (e *SFU) startTURN(c TURNConfig) error {
	if fips140.Enabled() {
		return errors.New("embedded TURN cannot run with FIPS mode enabled")
	}
	if len(c.Secret) < 32 || c.MinPort < 1024 || c.MaxPort > 65534 || c.MaxPort < c.MinPort || c.MaxAllocations < 1 || c.MaxAllocations > 1024 || int(c.MaxPort)-int(c.MinPort)+1 < c.MaxAllocations {
		return errors.New("invalid TURN capacity configuration")
	}
	certificate, err := tls.X509KeyPair([]byte(c.Certificate), []byte(c.PrivateKey))
	if err != nil {
		return errors.New("invalid TURN TLS configuration")
	}
	if c.UDPAddr == "" {
		c.UDPAddr = ":3478"
	}
	if c.TLSAddr == "" {
		c.TLSAddr = ":5349"
	}
	var listen net.ListenConfig
	udp, err := listen.ListenPacket(context.Background(), "udp", c.UDPAddr)
	if err != nil {
		return errors.New("cannot bind TURN UDP listener")
	}
	tcp, err := listen.Listen(context.Background(), "tcp", c.TLSAddr)
	if err != nil {
		_ = udp.Close()
		return errors.New("cannot bind TURN TLS listener")
	}
	public, _ := netip.ParseAddr(e.cfg.PublicIP)
	public = public.Unmap()
	_, portString, _ := net.SplitHostPort(e.udp.LocalAddr().String())
	port, _ := strconv.ParseUint(portString, 10, 16)
	address := "0.0.0.0"
	if public.Is6() {
		address = "::"
	}
	r := &turnRuntime{engine: e, cfg: c, udp: udp, target: netip.AddrPortFrom(public, uint16(port)), relays: map[*relayConn]bool{}, counts: map[string]int{}, connections: map[string]*turnTLSConnection{}, base: &turn.RelayAddressGeneratorPortRange{RelayAddress: net.ParseIP(e.cfg.PublicIP), Address: address, MinPort: c.MinPort, MaxPort: c.MaxPort, MaxRetries: 64}}
	listener := &turnTLSListener{Listener: limitListener(tcp), runtime: r, config: &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}}
	r.tlsListener = listener
	permission := func(_ net.Addr, peer net.IP) bool {
		addr, ok := netip.AddrFromSlice(peer)
		return ok && addr.Unmap() == public
	}
	server, err := turn.NewServer(turn.ServerConfig{Realm: turnRealm, LoggerFactory: mediaLogger, InboundMTU: 1500, AllocationLifetime: 10 * time.Minute,
		PacketConnConfigs: []turn.PacketConnConfig{{PacketConn: udp, RelayAddressGenerator: r, PermissionHandler: permission}},
		ListenerConfigs:   []turn.ListenerConfig{{Listener: listener, RelayAddressGenerator: r, PermissionHandler: permission}},
		AuthHandler:       r.authenticate,
		QuotaHandler: func(owner, realm string, _ net.Addr) bool {
			r.mu.Lock()
			defer r.mu.Unlock()
			return !r.closed && realm == turnRealm && r.counts[owner] < 4 && len(r.relays) < c.MaxAllocations
		},
		EventHandler: turn.EventHandler{
			OnAllocationCreated: func(src, dst net.Addr, protocol, owner, realm string, relay net.Addr, requested int) {
				r.mu.Lock()
				connection := r.connections[turnConnectionKey(src)]
				r.mu.Unlock()
				if connection != nil {
					connection.allocated.Store(true)
					_ = connection.conn.SetDeadline(time.Time{})
				}
			},
			OnAllocationDeleted: func(src, dst net.Addr, protocol, owner, realm string) {
				r.mu.Lock()
				connection := r.connections[turnConnectionKey(src)]
				r.mu.Unlock()
				if connection != nil {
					_ = connection.conn.Close()
				}
			},
		},
		StrictAddressFamily: public.Is4(),
	})
	if err != nil {
		_ = udp.Close()
		_ = listener.Close()
		return errors.New("cannot initialize embedded TURN")
	}
	r.server = server
	e.turn = r
	return nil
}
func (r *turnRuntime) authenticate(attributes *turn.RequestAttributes) (string, []byte, bool) {
	participant, fresh, valid := verifyTURNUsername(r.cfg.Secret, attributes.Username, time.Now())
	if !valid || attributes.Realm != turnRealm {
		return "", nil, false
	}
	r.engine.mu.Lock()
	peer := r.engine.peers[participant]
	r.engine.mu.Unlock()
	if peer == nil || peer.closed.Load() || !peer.ready.Load() || time.Now().UnixNano() >= peer.authorizedUntil.Load() {
		return "", nil, false
	}
	owner := participant + ":" + strconv.FormatInt(peer.generation, 10)
	if !fresh {
		r.mu.Lock()
		existing := r.counts[owner] > 0
		r.mu.Unlock()
		if attributes.Method == stun.MethodAllocate || !existing || !peer.permitted() {
			return "", nil, false
		}
	}
	return owner, turn.GenerateAuthKey(attributes.Username, turnRealm, turnMAC(r.cfg.Secret, "turn-password:"+attributes.Username)), true
}
func (r *turnRuntime) ownerActive(owner string) bool {
	participant, raw, ok := strings.Cut(owner, ":")
	if !ok {
		return false
	}
	generation, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return false
	}
	r.engine.mu.Lock()
	peer := r.engine.peers[participant]
	r.engine.mu.Unlock()
	return peer != nil && peer.generation == generation && !peer.closed.Load() && time.Now().UnixNano() < peer.authorizedUntil.Load()
}
func (r *turnRuntime) Validate() error { return r.base.Validate() }
func (r *turnRuntime) AllocatePacketConn(c turn.AllocateListenerConfig) (net.PacketConn, net.Addr, error) {
	if c.RequestedPort != 0 && (c.RequestedPort < int(r.cfg.MinPort) || c.RequestedPort > int(r.cfg.MaxPort)) {
		return nil, nil, errors.New("TURN requested port outside relay range")
	}
	if !r.ownerActive(c.UserID) {
		return nil, nil, ErrAdmission
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || len(r.relays) >= r.cfg.MaxAllocations || r.counts[c.UserID] >= 4 {
		return nil, nil, errors.New("TURN allocation quota")
	}
	conn, addr, err := r.base.AllocatePacketConn(c)
	if err != nil {
		return nil, nil, errors.New("TURN relay ports unavailable")
	}
	wrapped := &relayConn{PacketConn: conn, runtime: r, owner: c.UserID}
	r.relays[wrapped] = true
	r.counts[c.UserID]++
	return wrapped, addr, nil
}
func (r *turnRuntime) AllocateListener(turn.AllocateListenerConfig) (net.Listener, net.Addr, error) {
	return nil, nil, errors.New("TCP relay allocations are disabled")
}
func (r *turnRuntime) AllocateConn(turn.AllocateConnConfig) (net.Conn, error) {
	return nil, errors.New("TCP relay allocations are disabled")
}
func (r *turnRuntime) allowedTarget(addr net.Addr) bool {
	target, err := netip.ParseAddrPort(addr.String())
	return err == nil && target.Addr().Unmap() == r.target.Addr() && target.Port() == r.target.Port()
}
func (r *turnRuntime) drop(participant string, generation int64) {
	owner := participant + ":" + strconv.FormatInt(generation, 10)
	r.mu.Lock()
	list := []*relayConn{}
	for relay := range r.relays {
		if relay.owner == owner {
			list = append(list, relay)
		}
	}
	r.mu.Unlock()
	for _, relay := range list {
		_ = relay.Close()
	}
}
func (r *turnRuntime) Close() error {
	r.mu.Lock()
	r.closed = true
	connections := []net.Conn{}
	for _, entry := range r.connections {
		connections = append(connections, entry.conn)
	}
	relays := []*relayConn{}
	for relay := range r.relays {
		relays = append(relays, relay)
	}
	r.mu.Unlock()
	for _, conn := range connections {
		_ = conn.Close()
	}
	for _, relay := range relays {
		_ = relay.Close()
	}
	if r.udp != nil {
		_ = r.udp.Close()
	}
	if r.tlsListener != nil {
		_ = r.tlsListener.Close()
	}
	if r.server != nil {
		return r.server.Close()
	}
	return nil
}

type relayConn struct {
	net.PacketConn
	runtime *turnRuntime
	owner   string
	once    sync.Once
}

func (c *relayConn) WriteTo(b []byte, addr net.Addr) (int, error) {
	if len(b) > 1500 || !c.runtime.allowedTarget(addr) || !c.runtime.ownerActive(c.owner) {
		return 0, ErrAdmission
	}
	return c.PacketConn.WriteTo(b, addr)
}
func (c *relayConn) ReadFrom(b []byte) (int, net.Addr, error) {
	for {
		n, addr, err := c.PacketConn.ReadFrom(b)
		if err != nil {
			return n, addr, err
		}
		if !c.runtime.ownerActive(c.owner) {
			_ = c.Close()
			return 0, nil, net.ErrClosed
		}
		if n <= 1500 && c.runtime.allowedTarget(addr) {
			return n, addr, nil
		}
	}
}
func (c *relayConn) Close() error {
	var result error
	c.once.Do(func() {
		result = c.PacketConn.Close()
		r := c.runtime
		r.mu.Lock()
		defer r.mu.Unlock()
		delete(r.relays, c)
		r.counts[c.owner]--
		if r.counts[c.owner] == 0 {
			delete(r.counts, c.owner)
		}
	})
	return result
}
func turnConnectionKey(addr net.Addr) string { return addr.Network() + "|" + addr.String() }

type turnTLSListener struct {
	net.Listener
	runtime *turnRuntime
	config  *tls.Config
}

func (l *turnTLSListener) Accept() (net.Conn, error) {
	raw, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	key := turnConnectionKey(raw.RemoteAddr())
	tracked := &turnTrackedConn{Conn: raw, runtime: l.runtime, key: key}
	conn := tls.Server(tracked, l.config)
	entry := &turnTLSConnection{conn: conn}
	l.runtime.mu.Lock()
	l.runtime.connections[key] = entry
	l.runtime.mu.Unlock()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	time.AfterFunc(10*time.Second, func() {
		if !entry.allocated.Load() {
			_ = conn.Close()
		}
	})
	return conn, nil
}

type turnTrackedConn struct {
	net.Conn
	runtime *turnRuntime
	key     string
	once    sync.Once
}

func (c *turnTrackedConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() { c.runtime.mu.Lock(); defer c.runtime.mu.Unlock(); delete(c.runtime.connections, c.key) })
	return err
}
