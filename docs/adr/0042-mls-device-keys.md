# 0042. End-to-end encryption with device keys (MLS) (v0.39)

- Status: accepted
- Date: 2026-10-25

## Context

Item S1 of the 2026-10-23 plan. Encrypted channels (ADR 0028) shared one passphrase: it
had to travel outside Cenacle, could not be changed, and did not remove people who left.
The plan asked for per-device keys, device verification, key backup and escrow, and
encrypted files, with MLS (RFC 9420) for key exchange.

## Decisions

1. **MLS in the browser with ts-mls** (MIT, TypeScript, one dependency `@hpke/core`; its
   noble provider needs `@noble/hashes`, `@noble/ciphers`, `@noble/curves`, all MIT).
   Cipher suite 1 (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`, the one every MLS
   implementation has). The desktop app runs the same code; mobile follows in 1.1.
2. **A device is a browser profile or a desktop app install.** It makes an Ed25519 key,
   registers the public key, and uses the credential `<user id>:<device id>`. A credential
   is valid when the server lists that key for that device of that person; removed
   devices stay listed so their earlier commits and messages still verify. Fingerprints
   (16 bytes of SHA-256 of the key) let people verify devices in person; the mark is kept
   on the verifying device. Private keys live in IndexedDB as raw bytes (ts-mls signs
   with raw keys, so they cannot be non-extractable WebCrypto keys); the device keeps what
   it opened, since an MLS message opens once.
3. **The server is the delivery service and keeps no keys.** It orders a group's commits
   (the first for an epoch wins; others get 409 and retry), keeps the newest GroupInfo
   with the ratchet tree, and accepts application messages only for the current epoch
   and the channel's own group id, which it reads from the PrivateMessage header. That
   way every device in the group at the time can read every message.
4. **Devices join on their own** with an external commit from the GroupInfo, so no key
   packages are stored and nobody has to be online to add someone. The server allows an
   external join only for a member's own active device. Devices of people who left and
   removed devices are marked stale; the next member device that syncs commits their
   removal. Turning encryption on is irreversible and allowed for channel managers (and
   anyone in a conversation); channels shared with other servers cannot have it.
5. **Files** are encrypted with AES-256-GCM in the browser, a key per file inside the
   MLS message; the server stores them as `encrypted` with no scan, sniffing or preview.
6. **History backups and recovery key.** A device cannot decrypt messages from before it
   joined; the person's devices back up what they read, sealed with a 32-byte recovery key
   (HKDF → AES-256-GCM), so a new device restores history after the key is typed. The
   server keeps an HMAC verifier only. **Escrow** is optional per installation: recovery
   keys are also sealed for an organization P-256 key (ECDH with a one-time key, HKDF,
   AES-GCM); members are told; `server e2e-escrow` opens a person's backups offline and
   is audited. The formats are tested across WebCrypto and Go.
7. Passphrase channels (ADR 0028) keep working; new encrypted channels use device keys.

## Consequences

- Migration `00044_mls` (devices, groups, commits, members, recovery, backups, escrow;
  files.encrypted; MLS envelopes up to 32 000 characters). Rolling back deletes MLS
  messages; MLS channels stay encrypted and unreadable.
- Scheduled messages are refused in MLS channels (the epoch would be stale when sent).
- ts-mls has no independent audit yet; the v0.42 security review covers its use. A
  rejoin with `resync` for a leaf that is no longer in the tree loops in ts-mls 1.6.4, so
  the client only resyncs while its device is still in the group.
- Server-side features that read text (search, bots, link previews, AutoMod, AI,
  notification text) stay off in encrypted channels.
