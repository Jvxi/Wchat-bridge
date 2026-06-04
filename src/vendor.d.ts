declare module "qrcode-terminal" {
  const mod: {
    generate(text: string, opts?: { small?: boolean }): void;
    default?: { generate(text: string, opts?: { small?: boolean }): void };
  };
  export default mod;
}
