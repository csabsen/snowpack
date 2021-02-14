/**
 * This license applies to parts of this file originating from the
 * https://github.com/lukejacksonn/servor repository:
 *
 * MIT License
 * Copyright (c) 2019 Luke Jackson
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import cacache from 'cacache';
import isCompressible from 'compressible';
import {createLoader as createServerRuntime} from '../ssr-loader';
import etag from 'etag';
import {EventEmitter} from 'events';
import {createReadStream, promises as fs, statSync} from 'fs';
import http from 'http';
import http2 from 'http2';
import {isBinaryFile} from 'isbinaryfile';
import * as colors from 'kleur/colors';
import mime from 'mime-types';
import os, {tmpdir} from 'os';
import path from 'path';
import {performance} from 'perf_hooks';
import onProcessExit from 'signal-exit';
import stream from 'stream';
import url from 'url';
import util from 'util';
import zlib from 'zlib';
import {
  generateEnvModule,
  getMetaUrlPath,
  wrapHtmlResponse,
  wrapImportMeta,
  wrapImportProxy,
} from '../build/build-import-proxy';
import {buildFile, getInputsFromOutput} from '../build/build-pipeline';
import {getUrlsForFile, getMountEntryForFile} from '../build/file-urls';
import {createImportResolver} from '../build/import-resolver';
import {EsmHmrEngine} from '../hmr-server-engine';
import {logger} from '../logger';
import {
  scanCodeImportsExports,
  transformEsmImports,
  transformFileImports,
} from '../rewrite-imports';
import {matchDynamicImportValue} from '../scan-imports';
import {
  CommandOptions,
  LoadResult,
  MountEntry,
  OnFileChangeCallback,
  RouteConfigObject,
  SnowpackConfig,
  SnowpackSourceFile,
  SnowpackBuildMap,
  SnowpackDevServer,
  ServerRuntime,
  SnowpackBuiltFile,
} from '../types';
import {
  BUILD_CACHE,
  cssSourceMappingURL,
  getExtensionMatch,
  hasExtension,
  HMR_CLIENT_CODE,
  HMR_OVERLAY_CODE,
  isFsEventsEnabled,
  isRemoteUrl,
  jsSourceMappingURL,
  openInBrowser,
  readFile,
  relativeURL,
  removeExtension,
  replaceExtension,
} from '../util';
import {getPort, getServerInfoMessage, paintDashboard, paintEvent} from './paint';
import {getPackageSource} from '../sources/util';
import mkdirp from 'mkdirp';
import rimraf from 'rimraf';
import {glob} from 'glob';

class OneToManyMap {
  private keyToValue = new Map<string, string[]>();
  private valueToKey = new Map<string, string>();
  add(key: string, _value: string | string[]) {
    const value = Array.isArray(_value) ? _value : [_value];
    this.keyToValue.set(key, value);
    for (const val of value) {
      this.valueToKey.set(val, key);
    }
  }
  delete(key: string) {
    const value = this.value(key);
    this.keyToValue.delete(key);
    if (value) {
      for (const val of value) {
        this.keyToValue.delete(val);
      }
    }
  }
  key(value: string) {
    return this.valueToKey.get(value);
  }
  value(key: string) {
    return this.keyToValue.get(key);
  }
}

interface FoundFile {
  loc: string | undefined;
  type: string;
  contents: Buffer;
  isStatic: boolean;
  isResolve: boolean;
}

const FILE_BUILD_RESULT_ERROR = `Build Result Error: There was a problem with a file build result.`;

/**
 * If encoding is defined, return a string. Otherwise, return a Buffer.
 */
function encodeResponse(
  response: Buffer | string,
  encoding: BufferEncoding | undefined | null,
): Buffer | string {
  if (encoding === undefined) {
    return response;
  }
  if (encoding) {
    if (typeof response === 'string') {
      return response;
    } else {
      return response.toString(encoding);
    }
  }
  if (typeof response === 'string') {
    return Buffer.from(response);
  } else {
    return response;
  }
}

function getCacheKey(fileLoc: string, {isSSR, env}) {
  return `${fileLoc}?env=${env}&isSSR=${isSSR ? '1' : '0'}`;
}

/**
 * A helper class for "Not Found" errors, storing data about what file lookups were attempted.
 */
class NotFoundError extends Error {
  lookups: string[];

  constructor(lookups: string[]) {
    super('NOT_FOUND');
    this.lookups = lookups;
  }
}

function sendResponseFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  {contents, originalFileLoc, contentType}: LoadResult,
) {
  const body = Buffer.from(contents);
  const ETag = etag(body, {weak: true});
  const headers: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Content-Type': contentType || 'application/octet-stream',
    ETag,
    Vary: 'Accept-Encoding',
  };

  if (req.headers['if-none-match'] === ETag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  let acceptEncoding = (req.headers['accept-encoding'] as string) || '';
  if (
    req.headers['cache-control']?.includes('no-transform') ||
    ['HEAD', 'OPTIONS'].includes(req.method!) ||
    !contentType ||
    !isCompressible(contentType)
  ) {
    acceptEncoding = '';
  }

  // Handle gzip compression
  if (/\bgzip\b/.test(acceptEncoding) && stream.Readable.from) {
    const bodyStream = stream.Readable.from([body]);
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    stream.pipeline(bodyStream, zlib.createGzip(), res, function onError(err) {
      if (err) {
        res.end();
        logger.error(`✘ An error occurred serving ${colors.bold(req.url!)}`);
        logger.error(typeof err !== 'string' ? err.toString() : err);
      }
    });
    return;
  }

  // Handle partial requests
  // TODO: This throws out a lot of hard work, and ignores any build. Improve.
  const {range} = req.headers;
  if (range) {
    if (!originalFileLoc) {
      throw new Error('Virtual files do not support partial requests');
    }
    const {size: fileSize} = statSync(originalFileLoc);
    const [rangeStart, rangeEnd] = range.replace(/bytes=/, '').split('-');

    const start = parseInt(rangeStart, 10);
    const end = rangeEnd ? parseInt(rangeEnd, 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    const fileStream = createReadStream(originalFileLoc, {start, end});
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': chunkSize,
    });
    fileStream.pipe(res);
    return;
  }

  res.writeHead(200, headers);
  res.write(body);
  res.end();
}

function sendResponseError(req: http.IncomingMessage, res: http.ServerResponse, status: number) {
  const contentType = mime.contentType(path.extname(req.url!) || '.html');
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType || 'application/octet-stream',
    Vary: 'Accept-Encoding',
  };
  res.writeHead(status, headers);
  res.end();
}

function handleResponseError(req, res, err: Error | NotFoundError) {
  if (err instanceof NotFoundError) {
    // Don't log favicon "Not Found" errors. Browsers automatically request a favicon.ico file
    // from the server, which creates annoying errors for new apps / first experiences.
    if (req.url !== '/favicon.ico') {
      const attemptedFilesMessage = err.lookups.map((loc) => '  ✘ ' + loc).join('\n');
      logger.error(`[404] ${req.url}\n${attemptedFilesMessage}`);
    }
    sendResponseError(req, res, 404);
    return;
  }
  console.log(err);
  logger.error(err.toString());
  logger.error(`[500] ${req.url}`, {
    // @ts-ignore
    name: err.__snowpackBuildDetails?.name,
  });
  sendResponseError(req, res, 500);
  return;
}

function getServerRuntime(
  sp: SnowpackDevServer,
  options: {invalidateOnChange?: boolean} = {},
): ServerRuntime {
  const runtime = createServerRuntime({
    load: (url) => sp.loadUrl(url, {isSSR: true, allowStale: false, encoding: 'utf8'}),
  });
  if (options.invalidateOnChange !== false) {
    sp.onFileChange(({filePath}) => {
      const url = sp.getUrlForFile(filePath);
      if (url) {
        runtime.invalidateModule(url);
      }
    });
  }
  return runtime;
}

export async function startServer(commandOptions: CommandOptions): Promise<SnowpackDevServer> {
  const {config} = commandOptions;
  // Start the startup timer!
  let serverStart = performance.now();

  const {port: defaultPort, hostname, open} = config.devOptions;
  const messageBus = new EventEmitter();
  const port = await getPort(defaultPort);
  const pkgSource = getPackageSource(config.packageOptions.source);
  const PACKAGE_PATH_PREFIX = path.posix.join(config.buildOptions.metaUrlPath, 'pkg/');

  // Reset the clock if we had to wait for the user prompt to select a new port.
  if (port !== defaultPort) {
    serverStart = performance.now();
  }

  // Fill in any command-specific plugin methods.
  for (const p of config.plugins) {
    p.markChanged = (fileLoc) => {
      knownETags.clear();
      onWatchEvent(fileLoc);
    };
  }

  if (config.devOptions.output === 'dashboard') {
    // "dashboard": Pipe console methods to the logger, and then start the dashboard.
    logger.debug(`attaching console.log listeners`);
    console.log = (...args: [any, ...any[]]) => {
      logger.info(util.format(...args));
    };
    console.warn = (...args: [any, ...any[]]) => {
      logger.warn(util.format(...args));
    };
    console.error = (...args: [any, ...any[]]) => {
      logger.error(util.format(...args));
    };
    paintDashboard(messageBus, config);
    logger.debug(`dashboard started`);
  } else {
    // "stream": Log relevent events to the console.
    messageBus.on(paintEvent.WORKER_MSG, ({id, msg}) => {
      logger.info(msg.trim(), {name: id});
    });
    messageBus.on(paintEvent.SERVER_START, (info) => {
      console.log(getServerInfoMessage(info));
    });
  }

  const inMemoryBuildCache = new Map<string, FileBuilder>();
  const filesBeingDeleted = new Set<string>();
  // const filesBeingBuilt = new Map<string, Promise<SnowpackBuildMap>>();
  let mountedFiles = new OneToManyMap();

  for (const [mountKey, mountEntry] of Object.entries(config.mount)) {
    logger.debug(`Mounting directory: '${mountKey}' as URL '${mountEntry.url}'`);
    const files = glob.sync(path.join(mountKey, '**'), {nodir: true});
    for (const f of files) {
      mountedFiles.add(f, getUrlsForFile(f, config)!);
    }
  }

  console.log('DONE', mountedFiles);
  logger.debug(`Using in-memory cache.`);

  await pkgSource.prepare(commandOptions);
  const readCredentials = async (cwd: string) => {
    const [cert, key] = await Promise.all([
      fs.readFile(path.join(cwd, 'snowpack.crt')),
      fs.readFile(path.join(cwd, 'snowpack.key')),
    ]);

    return {
      cert,
      key,
    };
  };

  let credentials: {cert: Buffer; key: Buffer} | undefined;
  if (config.devOptions.secure) {
    try {
      logger.debug(`reading credentials`);
      credentials = await readCredentials(config.root);
    } catch (e) {
      logger.error(
        `✘ No HTTPS credentials found! Missing Files:  ${colors.bold(
          'snowpack.crt',
        )}, ${colors.bold('snowpack.key')}`,
      );
      logger.info(`You can automatically generate credentials for your project via either:

  - ${colors.cyan('devcert')}: ${colors.yellow('npx devcert-cli generate localhost')}
    https://github.com/davewasmer/devcert-cli (no install required)

  - ${colors.cyan('mkcert')}: ${colors.yellow(
        'mkcert -install && mkcert -key-file snowpack.key -cert-file snowpack.crt localhost',
      )}

    https://github.com/FiloSottile/mkcert (install required)`);
      process.exit(1);
    }
  }

  for (const runPlugin of config.plugins) {
    if (runPlugin.run) {
      logger.debug(`starting ${runPlugin.name} run() in watch/isDev mode`);
      runPlugin
        .run({
          isDev: true,
          // @ts-ignore: internal API only
          log: (msg, data) => {
            if (msg === 'CONSOLE_INFO') {
              logger.info(data.msg, {name: runPlugin.name});
            } else {
              messageBus.emit(msg, {...data, id: runPlugin.name});
            }
          },
        })
        .then(() => {
          logger.info('Command completed.', {name: runPlugin.name});
        })
        .catch((err) => {
          logger.error(`Command exited with error code: ${err}`, {name: runPlugin.name});
          process.exit(1);
        });
    }
  }

  class FileBuilder {
    output: SnowpackBuildMap = {};
    filesToResolve: Record<string, SnowpackSourceFile> = {};
    filesToProxy: string[] = [];
    isHMR: boolean;
    isSSR: boolean;
    isStatic: boolean;
    isResolve: boolean;
    buildPromise: Promise<SnowpackBuildMap> | undefined;

    readonly loc: string;
    // readonly mountEntry: MountEntry;
    // readonly outDir: string;
    readonly config: SnowpackConfig;

    constructor({
      loc,
      isHMR,
      isSSR,
      isStatic,
      isResolve,
      // mountEntry,
      // outDir,
      config,
    }: {
      loc: string;
      isHMR: boolean;
      isSSR: boolean;
      isStatic: boolean;
      isResolve: boolean;
      // mountEntry: MountEntry;
      // outDir: string;
      config: SnowpackConfig;
    }) {
      this.loc = loc;
      this.isHMR = isHMR;
      this.isSSR = isSSR;
      this.isStatic = isStatic;
      this.isResolve = isResolve;
      // this.mountEntry = mountEntry;
      // this.outDir = outDir;
      this.config = config;
    }

    private verifyRequestFromBuild(type: string): SnowpackBuiltFile {
      // Verify that the requested file exists in the build output map.
      if (!this.output[type] || !Object.keys(this.output)) {
        throw new Error(`Requested content "${type}" but built ${Object.keys(this.output)}`);
      }
      return this.output[type];
    }

    /**
     * Resolve Imports: Resolved imports are based on the state of the file
     * system, so they can't be cached long-term with the build.
     */
    private async resolveImports({
      contents: _contents,
      type,
      url,
      reqUrlHmrParam,
    }: {
      contents: string | Buffer;
      type: string;
      url: string;
      reqUrlHmrParam: string | false;
    }): Promise<string | Buffer> {
      if (typeof _contents !== 'string') {
        return _contents;
      }
      let contents = _contents;
      const resolveImportSpecifier = createImportResolver({
        fileLoc: this.loc,
        config,
      });
      contents = await transformFileImports({type, contents}, (spec) => {
        // Try to resolve the specifier to a known URL in the project
        let resolvedImportUrl = resolveImportSpecifier(spec);
        // Handle a package import
        if (!resolvedImportUrl) {
          resolvedImportUrl = pkgSource.resolvePackageImport(this.loc, spec, config);
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
        if (config.packageOptions.external?.includes(resolvedImportUrl)) {
          return spec;
        }
        // Handle normal "./" & "../" import specifiers
        const importExtName = path.posix.extname(resolvedImportUrl);
        const isProxyImport = importExtName && importExtName !== '.js' && importExtName !== '.mjs';
        const isAbsoluteUrlPath = path.posix.isAbsolute(resolvedImportUrl);
        if (isProxyImport) {
          resolvedImportUrl = resolvedImportUrl + '.proxy.js';
        }

        // When dealing with an absolute import path, we need to honor the baseUrl
        // proxy modules may attach code to the root HTML (like style) so don't resolve
        if (isAbsoluteUrlPath /* && !isProxyModule */) {
          resolvedImportUrl = relativeURL(path.posix.dirname(url), resolvedImportUrl);
        }
        // Make sure that a relative URL always starts with "./"
        if (!resolvedImportUrl.startsWith('.') && !resolvedImportUrl.startsWith('/')) {
          resolvedImportUrl = './' + resolvedImportUrl;
        }
        return resolvedImportUrl;
      });

      if (type === '.js' && reqUrlHmrParam)
        contents = await transformEsmImports(contents as string, (imp) => {
          const importUrl = path.posix.resolve(path.posix.dirname(url), imp);
          const node = hmrEngine.getEntry(importUrl);
          if (node && node.needsReplacement) {
            hmrEngine.markEntryForReplacement(node, false);
            return `${imp}?${reqUrlHmrParam}`;
          }
          return imp;
        });

      if (type === '.js') {
        const isHmrEnabled = contents.includes('import.meta.hot');
        const rawImports = await scanCodeImportsExports(contents);
        const resolvedImports = rawImports.map((imp) => {
          let spec = contents.substring(imp.s, imp.e);
          if (imp.d > -1) {
            spec = matchDynamicImportValue(spec) || '';
          }
          spec = spec.replace(/\?mtime=[0-9]+$/, '');
          return path.posix.resolve(path.posix.dirname(url), spec);
        });
        hmrEngine.setEntry(url, resolvedImports, isHmrEnabled);
      }

      return contents;
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
          isHmrEnabled: this.isHMR,
        });
        return builtFileOutput;
      })();
      this.buildPromise = fileBuilderPromise;
      try {
        messageBus.emit(paintEvent.BUILD_FILE, {id: this.loc, isBuilding: true});
        this.output = await fileBuilderPromise;
      } finally {
        this.buildPromise = undefined;
        messageBus.emit(paintEvent.BUILD_FILE, {id: this.loc, isBuilding: false});
      }
    }

    async getResult(
      url: string,
      type: string,
      reqUrlHmrParam: string | false,
    ): Promise<string | Buffer> {
      const {code, map} = this.verifyRequestFromBuild(type);
      let finalResponse = code;
      // Handle attached CSS.
      if (type === '.js' && this.output['.css']) {
        finalResponse = `import '${replaceExtension(url, '.js', '.css')}';\n` + finalResponse;
      }
      // Resolve imports.
      if (this.loc && (type === '.js' || type === '.html' || type === '.css')) {
        finalResponse = await this.resolveImports({
          url,
          type,
          contents: finalResponse,
          reqUrlHmrParam,
        });
      }
      // Wrap the response.
      switch (type) {
        case '.html': {
          finalResponse = wrapHtmlResponse({
            code: finalResponse as string,
            hmr: this.isHMR,
            hmrPort: hmrEngine.port !== port ? hmrEngine.port : undefined,
            isDev: true,
            config,
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
              config,
            });
          }

          // source mapping
          // if (sourceMap) code = jsSourceMappingURL(code, sourceMappingURL);

          break;
      }

      // Return the finalized response.
      return finalResponse;
    }

    getSourceMap(type: string): string | undefined {
      return this.output[type].map;
    }
    async getProxy(url: string, type: string) {
      const code = this.output[type].code;
      // TODO: support css modules
      return await wrapImportProxy({url, code, hmr: this.isHMR, config});
    }
  }

  function loadUrl(
    reqUrl: string,
    {
      isSSR: _isSSR,
      allowStale: _allowStale,
      encoding: _encoding,
    }?: {isSSR?: boolean; allowStale?: boolean; encoding?: undefined},
  ): Promise<LoadResult<Buffer | string>>;
  function loadUrl(
    reqUrl: string,
    {
      isSSR: _isSSR,
      allowStale: _allowStale,
      encoding: _encoding,
    }: {isSSR?: boolean; allowStale?: boolean; encoding: BufferEncoding},
  ): Promise<LoadResult<string>>;
  function loadUrl(
    reqUrl: string,
    {
      isSSR: _isSSR,
      allowStale: _allowStale,
      encoding: _encoding,
    }: {isSSR?: boolean; allowStale?: boolean; encoding: null},
  ): Promise<LoadResult<Buffer>>;
  async function loadUrl(
    reqUrl: string,
    {
      isSSR: _isSSR,
      isHMR: _isHMR,
      allowStale: _allowStale,
      encoding: _encoding,
    }: {
      isSSR?: boolean;
      isHMR?: boolean;
      allowStale?: boolean;
      encoding?: BufferEncoding | null;
    } = {},
  ): Promise<LoadResult> {
    const isSSR = _isSSR ?? false;
    //   // Default to HMR on, but disable HMR if SSR mode is enabled.
    const isHMR = _isHMR ?? ((config.devOptions.hmr ?? true) && !isSSR);
    const allowStale = _allowStale ?? false;
    const encoding = _encoding ?? null;
    const reqUrlHmrParam = reqUrl.includes('?mtime=') && reqUrl.split('?')[1];
    const reqPath = decodeURI(url.parse(reqUrl).pathname!);
    const resourcePath = reqUrl.replace(/\.map$/, '').replace(/\.proxy\.js$/, '');
    const resourceType = path.extname(resourcePath) || '.html';

    if (reqPath === getMetaUrlPath('/hmr-client.js', config)) {
      return {
        contents: encodeResponse(HMR_CLIENT_CODE, encoding),
        originalFileLoc: null,
        contentType: 'application/javascript',
      };
    }
    if (reqPath === getMetaUrlPath('/hmr-error-overlay.js', config)) {
      return {
        contents: encodeResponse(HMR_OVERLAY_CODE, encoding),
        originalFileLoc: null,
        contentType: 'application/javascript',
      };
    }
    if (reqPath === getMetaUrlPath('/env.js', config)) {
      return {
        contents: encodeResponse(generateEnvModule({mode: 'development', isSSR}), encoding),
        originalFileLoc: null,
        contentType: 'application/javascript',
      };
    }
    if (reqPath.startsWith(PACKAGE_PATH_PREFIX)) {
      const webModuleUrl = reqPath.substr(PACKAGE_PATH_PREFIX.length);
      const loadedModule = await pkgSource.load(webModuleUrl, commandOptions);
      return {
        contents: encodeResponse(loadedModule, encoding),
        originalFileLoc: null,
        contentType: mime.lookup(reqPath) || 'application/javascript',
      };
    }

    const attemptedFileLoc =
      mountedFiles.key(resourcePath) ||
      mountedFiles.key(resourcePath + '.html') ||
      mountedFiles.key(resourcePath + 'index.html') ||
      mountedFiles.key(resourcePath + '/index.html');
    if (!attemptedFileLoc) {
      throw new NotFoundError([reqPath]);
    }

    const [, mountEntry] = getMountEntryForFile(attemptedFileLoc, config)!;
    const foundFile = {
      loc: attemptedFileLoc,
      type: path.extname(reqPath) || '.html',
      contents: await fs.readFile(attemptedFileLoc),
      isStatic: mountEntry.static,
      isResolve: mountEntry.resolve,
    };

    function handleFinalizeError(err: Error) {
      logger.error(FILE_BUILD_RESULT_ERROR);
      hmrEngine.broadcastMessage({
        type: 'error',
        title: FILE_BUILD_RESULT_ERROR,
        errorMessage: err.toString(),
        fileLoc,
        errorStackTrace: err.stack,
      });
    }

    const {
      loc: fileLoc,
      type: responseType,
      contents: responseContents,
      isStatic: _isStatic,
      isResolve,
    } = foundFile;
    // Workaround: HMR plugins need to add scripts to HTML file, even if static.
    // TODO: Once plugins are able to add virtual files + imports, this will no longer be needed.
    const isStatic = _isStatic && responseType !== '.html';

    // 1. Check the hot build cache. If it's already found, then just serve it.
    const cacheKey = getCacheKey(fileLoc, {isSSR, env: process.env.NODE_ENV});
    let fileBuilder: FileBuilder | undefined = inMemoryBuildCache.get(cacheKey);

    if (!fileBuilder) {
      fileBuilder = new FileBuilder({loc: fileLoc, isSSR, isHMR, config, isStatic, isResolve});
      inMemoryBuildCache.set(cacheKey, fileBuilder);
      await fileBuilder.build();
    }

    let finalizedResponse: string | Buffer;
    if (reqUrl.endsWith('.proxy.js')) {
      finalizedResponse = await fileBuilder.getProxy(resourcePath, resourceType);
    } else if (reqUrl.endsWith('.proxy.js')) {
      const _finalizedResponse = await fileBuilder.getSourceMap(resourcePath);
      if (!_finalizedResponse) {
        throw new NotFoundError([reqPath]);
      }
      finalizedResponse = _finalizedResponse;
    } else {
      finalizedResponse = await fileBuilder.getResult(reqPath, resourceType, reqUrlHmrParam);
    }

    return {
      contents: encodeResponse(finalizedResponse, encoding),
      originalFileLoc: fileLoc,
      contentType: mime.lookup(responseType),
    };
  }

  /**
   * A simple map to optimize the speed of our 304 responses. If an ETag check is
   * sent in the request, check if it matches the last known etag for tat file.
   *
   * Remember: This is just a nice-to-have! If we get this logic wrong, it can mean
   * stale files in the user's cache. Feel free to clear aggressively, as needed.
   */
  const knownETags = new Map<string, string>();

  function matchRoute(reqUrl: string): RouteConfigObject | null {
    let reqPath = decodeURI(url.parse(reqUrl).pathname!);
    const reqExt = path.extname(reqPath);
    const isRoute = !reqExt || reqExt.toLowerCase() === '.html';
    for (const route of config.routes) {
      if (route.match === 'routes' && !isRoute) {
        continue;
      }
      if (route._srcRegex.test(reqPath)) {
        return route;
      }
    }
    return null;
  }

  /**
   * Fully handle the response for a given request. This is used internally for
   * every response that the dev server sends, but it can also be used via the
   * JS API to handle most boilerplate around request handling.
   */
  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    {handleError}: {handleError?: boolean} = {},
  ) {
    let reqUrl = req.url!;
    const matchedRoute = matchRoute(reqUrl);
    // If a route is matched, rewrite the URL or call the route function
    if (matchedRoute) {
      if (typeof matchedRoute.dest === 'string') {
        reqUrl = matchedRoute.dest;
      } else {
        return matchedRoute.dest(req, res);
      }
    }
    // Check if we can send back an optimized 304 response
    const quickETagCheck = req.headers['if-none-match'];
    const quickETagCheckUrl = reqUrl.replace(/\/$/, '/index.html');
    if (quickETagCheck && quickETagCheck === knownETags.get(quickETagCheckUrl)) {
      logger.debug(`optimized etag! sending 304...`);
      res.writeHead(304, {'Access-Control-Allow-Origin': '*'});
      res.end();
      return;
    }
    // Otherwise, load the file and respond if successful.
    try {
      const result = await loadUrl(reqUrl, {allowStale: true, encoding: null});
      sendResponseFile(req, res, result);
      if (result.checkStale) {
        await result.checkStale();
      }
      if (result.contents) {
        const tag = etag(result.contents, {weak: true});
        const reqPath = decodeURI(url.parse(reqUrl).pathname!);
        knownETags.set(reqPath, tag);
      }
      return;
    } catch (err) {
      // Some consumers may want to handle/ignore errors themselves.
      if (handleError === false) {
        throw err;
      }
      handleResponseError(req, res, err);
    }
  }

  type Http2RequestListener = (
    request: http2.Http2ServerRequest,
    response: http2.Http2ServerResponse,
  ) => void;
  const createServer = (responseHandler: http.RequestListener | Http2RequestListener) => {
    if (credentials) {
      return http2.createSecureServer(
        {...credentials!, allowHTTP1: true},
        responseHandler as Http2RequestListener,
      );
    }

    return http.createServer(responseHandler as http.RequestListener);
  };

  const server = createServer(async (req, res) => {
    // Attach a request logger.
    res.on('finish', () => {
      const {method, url} = req;
      const {statusCode} = res;
      logger.debug(`[${statusCode}] ${method} ${url}`);
    });
    // Otherwise, pass requests directly to Snowpack's request handler.
    handleRequest(req, res);
  })
    .on('error', (err: Error) => {
      logger.error(colors.red(`  ✘ Failed to start server at port ${colors.bold(port)}.`), err);
      server.close();
      process.exit(1);
    })
    .listen(port);

  const {hmrDelay} = config.devOptions;
  const hmrEngineOptions = Object.assign(
    {delay: hmrDelay},
    config.devOptions.hmrPort ? {port: config.devOptions.hmrPort} : {server, port},
  );
  const hmrEngine = new EsmHmrEngine(hmrEngineOptions);
  onProcessExit(() => {
    hmrEngine.disconnectAllClients();
  });

  // Live Reload + File System Watching
  let isLiveReloadPaused = false;

  function updateOrBubble(url: string, visited: Set<string>) {
    if (visited.has(url)) {
      return;
    }
    const node = hmrEngine.getEntry(url);
    const isBubbled = visited.size > 0;
    if (node && node.isHmrEnabled) {
      hmrEngine.broadcastMessage({type: 'update', url, bubbled: isBubbled});
    }
    visited.add(url);
    if (node && node.isHmrAccepted) {
      // Found a boundary, no bubbling needed
    } else if (node && node.dependents.size > 0) {
      node.dependents.forEach((dep) => {
        hmrEngine.markEntryForReplacement(node, true);
        updateOrBubble(dep, visited);
      });
    } else {
      // We've reached the top, trigger a full page refresh
      hmrEngine.broadcastMessage({type: 'reload'});
    }
  }
  function handleHmrUpdate(fileLoc: string, originalUrl: string) {
    if (isLiveReloadPaused) {
      return;
    }

    // CSS files may be loaded directly in the client (not via JS import / .proxy.js)
    // so send an "update" event to live update if thats the case.
    if (hasExtension(originalUrl, '.css') && !hasExtension(originalUrl, '.module.css')) {
      hmrEngine.broadcastMessage({type: 'update', url: originalUrl, bubbled: false});
    }

    // Append ".proxy.js" to Non-JS files to match their registered URL in the
    // client app.
    let updatedUrl = originalUrl;
    if (!hasExtension(updatedUrl, '.js')) {
      updatedUrl += '.proxy.js';
    }

    // Check if a virtual file exists in the resource cache (ex: CSS from a
    // Svelte file) If it does, mark it for HMR replacement but DONT trigger a
    // separate HMR update event. This is because a virtual resource doesn't
    // actually exist on disk, so we need the main resource (the JS) to load
    // first. Only after that happens will the CSS exist.
    const virtualCssFileUrl = updatedUrl.replace(/.js$/, '.css');
    const virtualNode = hmrEngine.getEntry(`${virtualCssFileUrl}.proxy.js`);
    if (virtualNode) {
      hmrEngine.markEntryForReplacement(virtualNode, true);
    }

    // If the changed file exists on the page, trigger a new HMR update.
    if (hmrEngine.getEntry(updatedUrl)) {
      updateOrBubble(updatedUrl, new Set());
      return;
    }

    // Otherwise, reload the page if the file exists in our hot cache (which
    // means that the file likely exists on the current page, but is not
    // supported by HMR (HTML, image, etc)).
    if (inMemoryBuildCache.has(getCacheKey(fileLoc, {isSSR: false, env: process.env.NODE_ENV}))) {
      hmrEngine.broadcastMessage({type: 'reload'});
      return;
    }
  }

  // Announce server has started
  const remoteIps = Object.values(os.networkInterfaces())
    .reduce((every: os.NetworkInterfaceInfo[], i) => [...every, ...(i || [])], [])
    .filter((i) => i.family === 'IPv4' && i.internal === false)
    .map((i) => i.address);
  const protocol = config.devOptions.secure ? 'https:' : 'http:';
  messageBus.emit(paintEvent.SERVER_START, {
    protocol,
    hostname,
    port,
    remoteIp: remoteIps[0],
    startTimeMs: Math.round(performance.now() - serverStart),
  });

  // Open the user's browser (ignore if failed)
  if (open !== 'none') {
    await openInBrowser(protocol, hostname, port, open).catch((err) => {
      logger.debug(`Browser open error: ${err}`);
    });
  }

  // Start watching the file system.
  // Defer "chokidar" loading to here, to reduce impact on overall startup time
  const chokidar = await import('chokidar');

  // Allow the user to hook into this callback, if they like (noop by default)
  let onFileChangeCallback: OnFileChangeCallback = () => {};

  // Watch src files
  async function onWatchEvent(fileLoc: string) {
    logger.info(colors.cyan('File changed...'));
    onFileChangeCallback({filePath: fileLoc});
    const updatedUrls = getUrlsForFile(fileLoc, config);
    if (updatedUrls) {
      handleHmrUpdate(fileLoc, updatedUrls[0]);
      knownETags.delete(updatedUrls[0]);
      knownETags.delete(updatedUrls[0] + '.proxy.js');
    }
    inMemoryBuildCache.delete(getCacheKey(fileLoc, {isSSR: true, env: process.env.NODE_ENV}));
    inMemoryBuildCache.delete(getCacheKey(fileLoc, {isSSR: false, env: process.env.NODE_ENV}));
    for (const plugin of config.plugins) {
      plugin.onChange && plugin.onChange({filePath: fileLoc});
    }
  }

  const watcher = chokidar.watch(Object.keys(config.mount), {
    persistent: true,
    ignoreInitial: false,
    disableGlobbing: false,
  });
  watcher.on('add', (fileLoc) => {
    knownETags.clear();
    onWatchEvent(fileLoc);
    mountedFiles.add(fileLoc, getUrlsForFile(fileLoc, config)!);
  });
  watcher.on('unlink', (fileLoc) => {
    knownETags.clear();
    onWatchEvent(fileLoc);
    mountedFiles.delete(fileLoc);
  });
  watcher.on('change', (fileLoc) => {
    onWatchEvent(fileLoc);
  });

  //TODO: Watch symlinked node_modules (removed temporarily)

  const sp = {
    port,
    loadUrl,
    handleRequest,
    sendResponseFile,
    sendResponseError,
    getUrlForFile: (fileLoc: string) => {
      const result = getUrlsForFile(fileLoc, config);
      return result ? result[0] : result;
    },
    onFileChange: (callback) => (onFileChangeCallback = callback),
    getServerRuntime: (options) => getServerRuntime(sp, options),
    async shutdown() {
      await watcher.close();
      server.close();
    },
  } as SnowpackDevServer;
  return sp;
}

export async function command(commandOptions: CommandOptions) {
  try {
    await startServer(commandOptions);
  } catch (err) {
    logger.error(err.message);
    logger.debug(err.stack);
    process.exit(1);
  }
  return new Promise(() => {});
}
