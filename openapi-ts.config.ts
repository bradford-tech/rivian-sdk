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
      name: "@hey-api/client-ofetch",
    },
    {
      name: "@hey-api/sdk",
      operations: {
        strategy: "byTags",
        containerName: "{{name}}",
      },
      validator: "zod",
    },
    {
      name: "@hey-api/transformers",
      dates: true,
    },
    "zod",
  ],
});
