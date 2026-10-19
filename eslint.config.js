// Lint config: only the security rule set for DOM sinks. innerHTML /
// insertAdjacentHTML / outerHTML with interpolated values must go through
// escapeHtml (or be reviewed and marked with a disable comment explaining why
// the value is trusted markup).
import nounsanitized from 'eslint-plugin-no-unsanitized';

export default [
  {
    files: ['src/js/**/*.js'],
    ignores: ['src/js/test/**', 'src/js/vendor/**'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    plugins: { 'no-unsanitized': nounsanitized },
    rules: {
      'no-unsanitized/property': ['error', { escape: { taggedTemplates: ['html'], methods: ['escapeHtml'] } }],
      'no-unsanitized/method': ['error', { escape: { taggedTemplates: ['html'], methods: ['escapeHtml'] } }],
    },
  },
];
