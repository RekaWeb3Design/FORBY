// Node resolve hook for running the TS sources directly (with --experimental-strip-types): the sources import
// relative modules without an extension, as the bundler allows; here "./x" falls back to "./x.ts"
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND" && specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      return next(`${specifier}.ts`, context);
    }
    throw err;
  }
}
