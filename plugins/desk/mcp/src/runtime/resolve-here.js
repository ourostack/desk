// Resolve a package specifier the way a module in this source tree imports it. importInChunks loads this file from the tree it is importing (the runtime's source mirror, with its own node_modules), so a package it loads early is the same file the tree's own import later finds in the module cache.
export function resolvePackage(specifier) {
  return import.meta.resolve(specifier)
}
