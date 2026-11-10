/** Historical wire/storage values: synthetic credentials, never retained state. */
export const PASSWORD = 'synthetic-migration-password-😀';
export const SALT = '0123456789abcdef'.repeat(4);
// PBKDF2-HMAC-SHA256, 600000 rounds, UTF-8 password and hex-decoded salt.
export const PASSWORD_HASH = '93a1dba502e9b5e7e24e5b75f1ddbd8a42412b98f8cdbc7ddf57d94cb7ad51b0';
export const TOKEN = 'synthetic-reference-session-credential-00000000000000000';
export const SESSION_HASH = '16bbb05cff9b29252c21030e9da3b6eac8b8377e83620129f46f762d290b7bc2';
export const APPLICATION_TOKEN = 'synthetic-reference-application-credential-00000000000000';
export const APPLICATION_HASH = '700223c12dd545925238134fcfdf979420413ac647b3399130a76f242c991b5f';
export const APPLICATION = {
  id: '11111111-2222-4333-8444-555555555555', name: 'Build agent', templates: [],
  limits: { resources: { cpu: 4, memoryMiB: 8192, diskGiB: 96 }, activeLeases: 2,
    defaultTTLSeconds: 1800, maxTTLSeconds: 3600, maxLifetimeSeconds: 86400, provisioningTimeoutSeconds: 900 },
};
