// Compile-time constant injected by electron/build.mjs (esbuild `define`).
// OCGO fork builds compile it to `true`; regular builds compile it to `false`.
// The declaration exists only so editors/type-checkers that do include this
// directory know the identifier; runtime code always tests
// `typeof __OCGO_BUILD__ !== "undefined"` first.
declare const __OCGO_BUILD__: boolean;
