# 0043. FIPS 140-3 images and a STIG profile (v0.40)

- Status: accepted
- Date: 2026-10-25

## Context

Item S2 of the 2026-10-23 plan: images built with validated cryptographic modules and
hardened configuration, as US public-sector deployments require.

## Decisions

1. **Go services use the Go Cryptographic Module v1.0.0** (`GOFIPS140=v1.0.0`, CMVP
   #5247), which the Go toolchain carries; no BoringCrypto or cgo. The server and the proxy
   (Caddy) get `-fips` images; `server version` and `server status` say whether FIPS mode
   is on. The web image serves static files behind the proxy and has no variant.
2. **Cenacle ID uses OpenSSL's FIPS provider 3.1.2** (CMVP #4985), built from the
   checksummed release sources in the image and loaded by node's own OpenSSL through
   `nodejs_conf` with `default_properties = fips=yes`; node runs with `--enable-fips`. No
   vendor base image (UBI, commercial distributions) is needed.
3. **Passwords in FIPS mode use PBKDF2-HMAC-SHA-512** (210,000 iterations), an approved
   function; Argon2id hashes are replaced at the next sign-in, and the other way round
   when an installation leaves FIPS mode.
4. **The notice and consent banner** is a setting of Cenacle ID (`IDP_SIGNIN_NOTICE`),
   enforced before every path that signs in, not only the password form.
5. **Hardening is checked, not only documented:** CI checks every image for setuid and
   setgid files and starts it read-only without capabilities; FIPS images must report
   FIPS mode. `stig.yml` adds limits and database logging to `prod.yml`; the Helm chart no
   longer mounts service account tokens.
6. Browsers stay outside the boundary: end-to-end encryption uses MLS suite 1 (X25519,
   Ed25519); FIPS deployments that need validated cryptography everywhere keep it off.

## Consequences

- Three more images per release (built for amd64 and arm64; the OpenSSL provider is
  compiled in the image build, which takes a few minutes, longer under arm64 emulation).
- No migration. Switching an installation to FIPS images changes password hashes as
  people sign in.
