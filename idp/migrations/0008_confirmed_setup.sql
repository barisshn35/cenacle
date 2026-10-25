-- SPDX-License-Identifier: AGPL-3.0-only
-- Cenacle ID: a two-step setup confirmed with a code inside a sign-in is its own
-- kind of challenge, so finishing the sign-in needs the code, not just the password.

-- Up Migration

ALTER TABLE mfa_challenges DROP CONSTRAINT mfa_challenges_purpose_check;
ALTER TABLE mfa_challenges ADD CONSTRAINT mfa_challenges_purpose_check
  CHECK (purpose IN ('login', 'account', 'setup_confirmed'));

-- Down Migration

DELETE FROM mfa_challenges WHERE purpose = 'setup_confirmed';
ALTER TABLE mfa_challenges DROP CONSTRAINT mfa_challenges_purpose_check;
ALTER TABLE mfa_challenges ADD CONSTRAINT mfa_challenges_purpose_check
  CHECK (purpose IN ('login', 'account'));
