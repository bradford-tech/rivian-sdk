import { defineConfig } from "@hey-api/openapi-ts";

export default defineConfig({
  input: "./specs/openapi.yaml",
  output: {
    path: "src/client",
    clean: true,
  },
  plugins: [
    "@hey-api/typescript",
    {
      name: "@hey-api/client-fetch",
    },
    {
      name: "@hey-api/sdk",
      operations: {
        strategy: "byTags",
        containerName: "{{name}}",
      },
    },
    {
      name: "@hey-api/transformers",
      dates: true,
    },
  ],
});
