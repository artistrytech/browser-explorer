type CssModule = Record<string, string>;

export function createCssModuleClassNames(...modules: CssModule[]) {
  return (...values: Array<string | false | null | undefined>) =>
    values
      .flatMap((value) => (value ? value.split(/\s+/) : []))
      .filter(Boolean)
      .map((name) => modules.find((module) => Object.prototype.hasOwnProperty.call(module, name))?.[name] ?? name)
      .join(' ');
}
