export const QUICKJS_STD_MODULE_DECLARATION = String.raw`
declare module "std" {
  const std: {
    err: { puts(value: string): void };
    in: { readAsString(): string };
    out: { puts(value: string): void };
  };
  export = std;
}
`;
