module.exports = {
  overrides: [
    {
      files: ["**/*.ts"],
      plugins: ["@typescript-eslint"],
      rules: {
        "@typescript-eslint/no-non-null-assertion": "off",
      },
    },
  ],
};
