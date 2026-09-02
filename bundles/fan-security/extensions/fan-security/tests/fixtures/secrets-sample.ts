/**
 * FIXTURE (TC-F-2.2-1) — фейковые, НЕВАЛИДНЫЕ секреты для тестов scan-secrets.
 * Ни одно значение ниже не является реальным ключом:
 *   - AWS: «AKIA + 16 символов» — тестовый формат из roadmap, невалиден в реальности;
 *   - GitHub / Slack — синтетические строки.
 * Тесты НЕ завязаны на номера строк — содержимое можно дополнять.
 */

// Тестовый AWS Access Key (формат roadmap TC-F-2.2-1: AKIA + 16 символов, невалидный реальный)
export const AWS_ACCESS_KEY_ID = "AKIAABCDEFGHIJKLMNOP";

// Фейковый GitHub PAT: ghp_ + ровно 36 символов (синтетика, невалиден)
export const GITHUB_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234";

// Фейковый Slack bot token: xoxb-… (синтетика, невалиден)
export const SLACK_BOT_TOKEN = "xoxb-123456789012-123456789012-FakeFakeFakeFake";
