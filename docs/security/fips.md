# FIPS 140-3 images

Cenacle publishes FIPS variants of the images that handle cryptography on the server:

| Image                 | Cryptographic module                                                                 |
| --------------------- | ------------------------------------------------------------------------------------ |
| `cenacle-server-fips` | Go Cryptographic Module v1.0.0 (`GOFIPS140=v1.0.0`; CMVP certificate #5247)          |
| `cenacle-proxy-fips`  | The same, in Caddy: TLS negotiates only FIPS 140-3 approved versions and suites      |
| `cenacle-idp-fips`    | OpenSSL FIPS provider 3.1.2 (CMVP certificate #4985), loaded by node `--enable-fips` |

Check the certificates' current status in NIST's CMVP list before relying on them; a
validation covers the module, not Cenacle as a whole.

## Using them

Compose: set `CENACLE_IMAGE_VARIANT=-fips` in `.env.prod`. Helm: `image.fips: true`. The web
image serves static files behind the proxy and has no FIPS variant.

```sh
docker compose … run --rm server version      # prints "(FIPS 140-3 mode)"
docker compose … run --rm server status       # "fips140": true
```

Cenacle ID logs `fips140: true` when it starts. The images are checked in CI: the server
reports FIPS mode, Cenacle ID runs with `crypto.getFips() === 1` and the proxy is built with
the module v1.0.0.

## What changes in FIPS mode

- **Passwords in Cenacle ID** are hashed with PBKDF2-HMAC-SHA-512 (210,000 iterations, NIST
  SP 800-132) instead of Argon2id. An existing Argon2id hash is checked once more at the
  next sign-in and replaced; switching back to a standard image does the opposite.
- **TLS** (proxy, the server's outbound requests) uses approved protocol versions, cipher
  suites and key exchanges only.
- Cenacle ID's OpenSSL allows approved algorithms only (`default_properties = fips=yes`):
  signing keys, cookies, TOTP and key encryption use them already.

## Outside the module boundary

- **End-to-end encryption with device keys** runs in browsers and the desktop app with
  X25519, Ed25519 and AES-128-GCM (MLS cipher suite 1). Browsers are not FIPS modules, and
  X25519 is not an approved key agreement. Organizations that need FIPS-validated
  cryptography end to end keep end-to-end encryption off.
- PostgreSQL, Valkey, the object store and ClamAV are separate services; use their own FIPS
  builds or a FIPS-enabled host where required, and encrypt their disks at the host.
