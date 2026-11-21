/**
 * Commit message rules — Angular convention + one project-specific requirement:
 * every message must contain Chinese characters.
 *
 * Why: the repo is Chinese/English bilingual, and an English-only subject loses the
 * "what actually changed" detail that this project's history depends on. The rule checks
 * the raw message (header, body, footer), so a Chinese body alone satisfies it.
 *
 * Run manually:  npx commitlint --edit .git/COMMIT_EDITMSG
 * Check a string: npx commitlint <<< "feat(opencode): 新增三上游 provider"
 */

const HAN = /\p{Script=Han}/u;

/** Header must use one of the Angular types; the list is enforced by config-angular. */
export default {
  extends: ["@commitlint/config-angular"],
  rules: {
    // Chinese subjects are not "ASCII sentence case"; keep the header check meaningful
    // (length + type + scope) without fighting the language.
    "subject-case": [0],
    "body-max-line-length": [2, "always", 200],
    // Subject line budget: Angular default is 100; Chinese characters are wider on screen.
    "header-max-length": [2, "always", 120],
    "commit-message-han": [2, "always"],
  },
  plugins: [
    {
      rules: {
        "commit-message-han": ({ raw }) => {
          const message = raw ?? "";
          return [
            HAN.test(message),
            "提交信息必须包含汉字，用中文说明改了什么（类型与 scope 仍用英文，如 feat(opencode): 接入 go/zen 三上游）",
          ];
        },
      },
    },
  ],
};
