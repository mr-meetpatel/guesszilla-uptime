import { parse, printParseErrorCode } from "jsonc-parser";

export function parseWranglerConfig(source) {
  const errors = [];
  const config = parse(source, errors, { allowTrailingComma: true });
  if (errors.length) {
    const error = errors[0];
    throw new Error(
      `Invalid wrangler.jsonc: ${printParseErrorCode(error.error)} at offset ${error.offset}`,
    );
  }
  return config;
}
