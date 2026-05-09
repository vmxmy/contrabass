declare module "*.sql?raw" {
  const content: string;
  export default content;
}

declare module "*.toml?raw" {
  const content: string;
  export default content;
}

declare module "*.md?raw" {
  const content: string;
  export default content;
}
