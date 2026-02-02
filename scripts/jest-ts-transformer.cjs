const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

let cachedCompilerOptions;
let cachedTsConfigMtimeMs;

function loadCompilerOptions() {
  const tsconfigPath = path.resolve(__dirname, '..', 'tsconfig.json');
  let stat;
  try {
    stat = fs.statSync(tsconfigPath);
  } catch {
    cachedCompilerOptions = cachedCompilerOptions ?? {};
    return cachedCompilerOptions;
  }

  if (cachedCompilerOptions && cachedTsConfigMtimeMs === stat.mtimeMs) {
    return cachedCompilerOptions;
  }

  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config ?? {},
    ts.sys,
    path.dirname(tsconfigPath),
  );

  cachedCompilerOptions = {
    ...parsed.options,
    module: ts.ModuleKind.CommonJS,
    sourceMap: true,
    inlineSources: true,
  };
  cachedTsConfigMtimeMs = stat.mtimeMs;

  return cachedCompilerOptions;
}

module.exports = {
  process(sourceText, sourcePath) {
    const compilerOptions = loadCompilerOptions();
    const transpiled = ts.transpileModule(sourceText, {
      compilerOptions,
      fileName: sourcePath,
      reportDiagnostics: false,
    });

    return {
      code: transpiled.outputText,
      map: transpiled.sourceMapText ?? undefined,
    };
  },
};

