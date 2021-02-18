import {promises as fs} from 'fs';
import mkdirp from 'mkdirp';
import path from 'path';
import url from 'url';
import {EsmHmrEngine} from '../hmr-server-engine';
import {
  scanCodeImportsExports,
  transformEsmImports,
  transformFileImports,
} from '../rewrite-imports';
import {matchDynamicImportValue} from '../scan-imports';
import {getPackageSource} from '../sources/util';
import {
  ImportMap,
  SnowpackBuildMap,
  SnowpackBuildResultFileManifest,
  SnowpackBuiltFile,
  SnowpackConfig,
} from '../types';
import {isRemoteUrl, relativeURL, replaceExtension} from '../util';
import {wrapHtmlResponse, wrapImportMeta, wrapImportProxy} from './build-import-proxy';
import {buildFile} from './build-pipeline';
import {getUrlsForFile} from './file-urls';
import {createImportResolver} from './import-resolver';

/**
 * FileBuilder - This class is responsible for building a file. It is broken into
 * individual stages so that the entire application build process can be tackled
 * in stages (build -> resolve -> get response).
 */
export class FileBuilder {
  buildOutput: SnowpackBuildMap = {};
  resolvedOutput: SnowpackBuildMap = {};
  proxyImports: string[] = [];

  isHMR: boolean;
  isSSR: boolean;
  isStatic: boolean;
  isResolve: boolean;
  buildPromise: Promise<SnowpackBuildMap> | undefined;

  readonly loc: string;
  readonly urls: string[];
  readonly config: SnowpackConfig;
  hmrEngine: EsmHmrEngine | null = null;

  constructor({
    loc,
    isHMR,
    isSSR,
    isStatic,
    isResolve,
    config,
    hmrEngine,
  }: {
    loc: string;
    isHMR: boolean;
    isSSR: boolean;
    isStatic: boolean;
    isResolve: boolean;
    config: SnowpackConfig;
    hmrEngine?: EsmHmrEngine | null;
  }) {
    this.loc = loc;
    this.isHMR = isHMR;
    this.isSSR = isSSR;
    this.isStatic = isStatic;
    this.isResolve = isResolve;
    this.config = config;
    this.hmrEngine = hmrEngine || null;
    this.urls = getUrlsForFile(loc, config);
    console.log(this.urls);
  }

  private verifyRequestFromBuild(type: string): SnowpackBuiltFile {
    // Verify that the requested file exists in the build output map.
    if (!this.resolvedOutput[type] || !Object.keys(this.resolvedOutput)) {
      throw new Error(`Requested content "${type}" but built ${Object.keys(this.resolvedOutput)}`);
    }
    return this.resolvedOutput[type];
  }

  /**
   * Resolve Imports: Resolved imports are based on the state of the file
   * system, so they can't be cached long-term with the build.
   */
  async resolveImports(hmrParam?: string | false, importMap?: ImportMap): Promise<void> {
    const urlPathDirectory = path.posix.dirname(this.urls[0]!);
    const pkgSource = getPackageSource(this.config.packageOptions.source);
    for (const [type, outputResult] of Object.entries(this.buildOutput)) {
      console.log('OKAY', this.loc, type);
      if (!(type === '.js' || type === '.html' || type === '.css')) {
        continue;
      }
      let contents =
        typeof outputResult.code === 'string'
          ? outputResult.code
          : outputResult.code.toString('utf8');

      // Handle attached CSS.
      if (type === '.js' && this.buildOutput['.css']) {
        const relativeCssImport = `./${replaceExtension(
          path.posix.basename(this.urls[0]!),
          '.js',
          '.css',
        )}`;
        contents = `import '${relativeCssImport}';\n` + contents;
      }
      const resolveImportSpecifier = createImportResolver({
        fileLoc: this.loc,
        config: this.config,
      });
      contents = await transformFileImports({type, contents}, async (spec) => {
        // Try to resolve the specifier to a known URL in the project
        let resolvedImportUrl = resolveImportSpecifier(spec);
        // Handle a package import
        console.log(spec, importMap);
        if (!resolvedImportUrl && importMap) {
          if (importMap.imports[spec]) {
            const PACKAGE_PATH_PREFIX = path.posix.join(
              this.config.buildOptions.metaUrlPath,
              'pkg/',
            );
            return path.posix.join(PACKAGE_PATH_PREFIX, importMap.imports[spec]);
          }
          // TODO: Not getting reported during build?
          throw new Error(`Unexpected: spec ${spec} not included in import map.`);
        }
        if (!resolvedImportUrl) {
          resolvedImportUrl = await pkgSource.resolvePackageImport(this.loc, spec, this.config);
        }
        // Handle a package import that couldn't be resolved
        if (!resolvedImportUrl) {
          return spec;
        }
        // Ignore "http://*" imports
        if (isRemoteUrl(resolvedImportUrl)) {
          return resolvedImportUrl;
        }
        // Ignore packages marked as external
        if (this.config.packageOptions.external?.includes(resolvedImportUrl)) {
          return spec;
        }

        // Handle normal "./" & "../" import specifiers
        const importExtName = path.posix.extname(resolvedImportUrl);
        const isProxyImport = importExtName && importExtName !== '.js' && importExtName !== '.mjs';
        const isAbsoluteUrlPath = path.posix.isAbsolute(resolvedImportUrl);
        if (isProxyImport) {
          this.proxyImports.push(path.posix.resolve(urlPathDirectory, resolvedImportUrl));
          resolvedImportUrl = resolvedImportUrl + '.proxy.js';
        }

        // When dealing with an absolute import path, we need to honor the baseUrl
        // proxy modules may attach code to the root HTML (like style) so don't resolve
        if (isAbsoluteUrlPath /* && !isProxyModule */) {
          resolvedImportUrl = relativeURL(urlPathDirectory, resolvedImportUrl);
        }
        // Make sure that a relative URL always starts with "./"
        if (!resolvedImportUrl.startsWith('.') && !resolvedImportUrl.startsWith('/')) {
          resolvedImportUrl = './' + resolvedImportUrl;
        }
        return resolvedImportUrl;
      });

      if (type === '.js' && hmrParam) {
        contents = await transformEsmImports(contents as string, (imp) => {
          const importUrl = path.posix.resolve(urlPathDirectory, imp);
          const node = this.hmrEngine?.getEntry(importUrl);
          if (node && node.needsReplacement) {
            this.hmrEngine?.markEntryForReplacement(node, false);
            return `${imp}?${hmrParam}`;
          }
          return imp;
        });
      }

      if (type === '.js') {
        const isHmrEnabled = contents.includes('import.meta.hot');
        const rawImports = await scanCodeImportsExports(contents);
        const resolvedImports = rawImports.map((imp) => {
          let spec = contents.substring(imp.s, imp.e);
          if (imp.d > -1) {
            spec = matchDynamicImportValue(spec) || '';
          }
          spec = spec.replace(/\?mtime=[0-9]+$/, '');
          return path.posix.resolve(urlPathDirectory, spec);
        });
        this.hmrEngine?.setEntry(this.urls[0], resolvedImports, isHmrEnabled);
      }
      // Update the output with the new resolved imports
      this.resolvedOutput[type].code = contents;
      this.resolvedOutput[type].map = undefined;
    }
  }

  /**
   * Given a file, build it. Building a file sends it through our internal
   * file builder pipeline, and outputs a build map representing the final
   * build. A Build Map is used because one source file can result in multiple
   * built files (Example: .svelte -> .js & .css).
   */
  async build() {
    if (this.buildPromise) {
      return this.buildPromise;
    }
    const fileBuilderPromise = (async () => {
      const builtFileOutput = await buildFile(url.pathToFileURL(this.loc), {
        config: this.config,
        isDev: true,
        isSSR: this.isSSR,
        isPackage: false,
        isHmrEnabled: this.isHMR,
      });
      return builtFileOutput;
    })();
    this.buildPromise = fileBuilderPromise;
    try {
      this.resolvedOutput = {};
      this.buildOutput = await fileBuilderPromise;
      console.log(this.buildOutput);
      for (const [outputKey, {code, map}] of Object.entries(this.buildOutput)) {
        this.resolvedOutput[outputKey] = {code, map};
      }
    } finally {
      this.buildPromise = undefined;
    }
  }

  getResult(type: string): string | Buffer {
    const {code /*, map */} = this.verifyRequestFromBuild(type);
    let finalResponse = code;
    // Wrap the response.
    switch (type) {
      case '.html': {
        finalResponse = wrapHtmlResponse({
          code: finalResponse as string,
          hmr: this.isHMR,
          hmrPort: this.hmrEngine ? this.hmrEngine.port : undefined,
          isDev: true,
          config: this.config,
          mode: 'development',
        });
        break;
      }
      case '.css': {
        // if (sourceMap) code = cssSourceMappingURL(code as string, sourceMappingURL);
        break;
      }
      case '.js':
        {
          // if (isProxyModule) {
          //   code = await wrapImportProxy({url: reqPath, code, hmr: isHMR, config});
          // } else {
          finalResponse = wrapImportMeta({
            code: finalResponse as string,
            env: true,
            hmr: this.isHMR,
            config: this.config,
          });
        }

        // source mapping
        // if (sourceMap) code = jsSourceMappingURL(code, sourceMappingURL);

        break;
    }

    // Return the finalized response.
    return finalResponse;
  }

  async getAllResults(): Promise<Record<string, string | Buffer>> {
    const results: Record<string, string | Buffer> = {};
    for (const url of this.urls) {
      results[url] = await this.getResult(path.extname(url));
    }
    return results;
  }

  //   async resolveImports(
  //     type: string,
  //     contents: string | Buffer,
  //     hmrParam: string | false,
  //   ): Promise<string | Buffer> {
  //     if (type === '.js' || type === '.html' || type === '.css') {
  //       return this.resolveImports({
  //         url: this.urls[0]!,
  //         type,
  //         contents,
  //         reqUrlHmrParam: hmrParam,
  //       });
  //     }
  //     return contents;
  //   }

  async getSourceMap(type: string): Promise<string | undefined> {
    return this.resolvedOutput[type].map;
  }
  async getProxy(url: string, type: string) {
    const code = this.resolvedOutput[type].code;
    // TODO: support css modules
    return await wrapImportProxy({url, code, hmr: this.isHMR, config: this.config});
  }

  // TODO: Add a generic writeFileToDisk that handles mkdirp, etc.

  async writeToDisk(dir: string, results: SnowpackBuildResultFileManifest) {
    await mkdirp(path.dirname(path.join(dir, this.urls[0])));
    for (const outUrl of this.urls) {
      //   const buildOutput = this.resolvedOutput[path.extname(outUrl)];
      const buildOutput = results[outUrl].contents;
      const encoding = typeof buildOutput === 'string' ? 'utf8' : undefined;
      await fs.writeFile(path.join(dir, outUrl), buildOutput, encoding);
    }
  }
}
