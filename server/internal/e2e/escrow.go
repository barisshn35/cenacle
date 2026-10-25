// SPDX-License-Identifier: AGPL-3.0-only

// Package e2e opens what browsers seal for end-to-end encryption, for the one
// case the server's operators may: an organization that requires escrow opens
// a person's history backups with its offline private key (server e2e-escrow).
// The formats are those of web/src/app/e2e/recovery.ts.
package e2e

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
)

const (
	recoveryLabel = "cenacle-recovery-check"
	backupInfo    = "cenacle-backup-v1"
	escrowInfo    = "cenacle-escrow-v1"
	version1      = 1
	p256Point     = 65 // an uncompressed P-256 public key
)

var errFormat = errors.New("e2e: not a sealed value of this version")

// Verifier is what the server keeps to recognize a recovery key.
func Verifier(recoveryKey []byte) []byte {
	m := hmac.New(sha256.New, recoveryKey)
	m.Write([]byte(recoveryLabel))
	return m.Sum(nil)
}

func open(key, iv, sealed []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, iv, sealed, nil)
}

// OpenEscrow returns the recovery key sealed for the escrow key.
func OpenEscrow(escrow *ecdh.PrivateKey, blob []byte) ([]byte, error) {
	if len(blob) < 1+p256Point+12+16 || blob[0] != version1 {
		return nil, errFormat
	}
	once, err := ecdh.P256().NewPublicKey(blob[1 : 1+p256Point])
	if err != nil {
		return nil, fmt.Errorf("e2e: %w", err)
	}
	shared, err := escrow.ECDH(once)
	if err != nil {
		return nil, fmt.Errorf("e2e: %w", err)
	}
	kek, err := hkdf.Key(sha256.New, shared, blob[1:1+p256Point], escrowInfo, 32)
	if err != nil {
		return nil, err
	}
	key, err := open(kek, blob[1+p256Point:1+p256Point+12], blob[1+p256Point+12:])
	if err != nil {
		return nil, fmt.Errorf("e2e: the escrow key does not open this recovery key: %w", err)
	}
	return key, nil
}

// OpenBackup returns the JSON of a history backup.
func OpenBackup(recoveryKey, blob []byte) ([]byte, error) {
	if len(blob) < 1+12+16 || blob[0] != version1 {
		return nil, errFormat
	}
	key, err := hkdf.Key(sha256.New, recoveryKey, nil, backupInfo, 32)
	if err != nil {
		return nil, err
	}
	return open(key, blob[1:13], blob[13:])
}

// ParsePrivateKey reads a P-256 private key (PEM: PKCS #8 or SEC 1).
func ParsePrivateKey(data []byte) (*ecdh.PrivateKey, error) {
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("e2e: no PEM block")
	}
	if k, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if ec, ok := k.(interface {
			ECDH() (*ecdh.PrivateKey, error)
		}); ok {
			return ec.ECDH()
		}
		return nil, errors.New("e2e: not an EC key")
	}
	k, err := x509.ParseECPrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("e2e: %w", err)
	}
	return k.ECDH()
}
