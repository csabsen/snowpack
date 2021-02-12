import {buildFile} from '../build/build-pipeline';
import url from 'url';
import etag from 'etag';
import crypto from 'crypto';
import {install as esinstall, InstallTarget, resolveEntrypoint} from 'esinstall';
import projectCacheDir from 'find-cache-dir';
import {existsSync, promises as fs, readFileSync} from 'fs';
import PQueue from 'p-queue';
import path from 'path';
import rimraf from 'rimraf';
import util from 'util';
import type {Plugin as RollupPlugin} from 'rollup';
import {logger} from '../logger';
import {transformAddMissingDefaultExport} from '../rewrite-imports';
import {getInstallTargets} from '../scan-imports';
import {CommandOptions, PackageSource, SnowpackConfig} from '../types';
import {GLOBAL_CACHE_DIR} from '../util';

const PROJECT_CACHE_DIR =
  projectCacheDir({name: 'snowpack'}) ||
  // If `projectCacheDir()` is null, no node_modules directory exists.
  // Use the current path (hashed) to create a cache entry in the global cache instead.
  // Because this is specifically for dependencies, this fallback should rarely be used.
  path.join(GLOBAL_CACHE_DIR, crypto.createHash('md5').update(process.cwd()).digest('hex'));

const DEV_DEPENDENCIES_DIR = path.join(PROJECT_CACHE_DIR, process.env.NODE_ENV || 'development');

/**
 * Sanitizes npm packages that end in .js (e.g `tippy.js` -> `tippyjs`).
 * This is necessary because Snowpack can’t create both a file and directory
 * that end in .js.
 */
export function sanitizePackageName(filepath: string): string {
  const dirs = filepath.split('/');
  const file = dirs.pop() as string;
  return [...dirs.map((path) => path.replace(/\.js$/i, 'js')), file].join('/');
}

function getRootPackageDirectory(loc: string) {
  const parts = loc.split('node_modules');
  const packageParts = parts.pop()!.split('/').filter(Boolean);
  const packageRoot = path.join(parts.join('node_modules'), 'node_modules');
  if (packageParts[0].startsWith('@')) {
    return path.join(packageRoot, packageParts[0], packageParts[1]);
  } else {
    return path.join(packageRoot, packageParts[0]);
  }
}

// A bit of a hack: we keep this in local state and populate it
// during the "prepare" call. Useful so that we don't need to pass
// this implementation detail around outside of this interface.
// Can't add it to the exported interface due to TS.
let config: SnowpackConfig;

let installTargets: InstallTarget[] = [];
const allHashes: Record<string, string> = {};
const inProgress = new PQueue({concurrency: 1});
/**
 * Local Package Source: A generic interface through which Snowpack
 * interacts with esinstall and your locally installed dependencies.
 */
export default {
  async load(id: string): Promise<Buffer | string> {
    const idParts = id.split('/');
    let hash = idParts.shift()!;
    const isLookup = idParts[0] !== '-';
    if (!isLookup) {
      idParts.shift();
    }
    console.log(allHashes, hash);
    const isRaw = hash.startsWith('raw:');
    if (isRaw) {
      hash = hash.replace('raw:', 'local:');
    }
    const rootPackageDirectory = allHashes[hash];
    const entrypointPackageManifestLoc = path.join(rootPackageDirectory, 'package.json');
    const entrypointPackageManifestStr = await fs.readFile(entrypointPackageManifestLoc, 'utf8');
    const entrypointPackageManifest = JSON.parse(entrypointPackageManifestStr);
    const packageName = entrypointPackageManifest.name;

    const spec = idParts.join('/');
    const internalSpec = spec.replace(packageName + '/', '');

    if (isRaw) {
      let installedPackageCode = await fs.readFile(
        path.join(rootPackageDirectory, internalSpec),
        'utf8',
      );
      return installedPackageCode;
    }
    const installDest = path.join(
      DEV_DEPENDENCIES_DIR,
      entrypointPackageManifest.name + '@' + entrypointPackageManifest.version,
    );
    let existsAndIsValid = existsSync(installDest);

    if (
      etag(entrypointPackageManifestStr) !==
      (await fs.readFile(path.join(installDest, '.hash'), 'utf-8').catch((err) => null))
    ) {
      existsAndIsValid = false;
    }

    const importMap =
      existsAndIsValid &&
      JSON.parse((await fs.readFile(path.join(installDest, 'import-map.json'), 'utf8'))!);

    if (!isLookup) {
      await inProgress.onIdle();
      const dependencyFileLoc = path.join(installDest, spec);
      let installedPackageCode = await fs.readFile(dependencyFileLoc!, 'utf8');
      installedPackageCode = await transformAddMissingDefaultExport(installedPackageCode);
      // TODO: Always pass the result through our normal build pipeline, for unbundled packages and such
      return installedPackageCode;
    }

    if (isLookup && importMap && importMap.imports[spec]) {
      await inProgress.onIdle();
      const finalLocation = path.posix.join(
        config.buildOptions.metaUrlPath,
        'pkg',
        hash,
        `-`,
        importMap.imports[spec],
      );
      return `export * from "${finalLocation}"; export {default} from "${finalLocation}";`;
    }

    return inProgress.add(async () => {
      const importMap =
        existsSync(installDest) &&
        JSON.parse((await fs.readFile(path.join(installDest, 'import-map.json'), 'utf8'))!);
      const existingEntrypoints = importMap ? Object.keys(importMap.imports) : [];
      let installEntrypoints = Array.from(
        new Set([
          ...existingEntrypoints,
          spec,
          ...installTargets
            .map((t) => t.specifier)
            .filter((t) => t === packageName || t.startsWith(packageName + '/')),
        ]),
      );
      console.time(spec);
      // TODO: external should be a function in esinstall
      const external = [
        ...Object.keys(entrypointPackageManifest.dependencies || {}),
        ...Object.keys(entrypointPackageManifest.devDependencies || {}),
        ...Object.keys(entrypointPackageManifest.peerDependencies || {}),
      ];

      const finalResult = await esinstall(installEntrypoints, {
        dest: installDest,
        env: {NODE_ENV: process.env.NODE_ENV || 'development'},
        treeshake: false,
        cwd: entrypointPackageManifestLoc,
        external,
        externalEsm: external,
        logger: {
          debug: (...args: [any, ...any[]]) => logger.debug(util.format(...args)),
          log: (...args: [any, ...any[]]) => logger.info(util.format(...args)),
          warn: (...args: [any, ...any[]]) => logger.warn(util.format(...args)),
          error: (...args: [any, ...any[]]) => logger.error(util.format(...args)),
        },
        packageExportLookupFields: ['svelte'],
        packageLookupFields: ['svelte'],
        rollup: {
          plugins: [
            {
              name: 'esinstall:snowpack',
              resolveId(source: string, importer: string | undefined) {
                // console.log('resolveId', source, importer);
                return source;
              },
              async load(id: string) {
                // console.log('load', id);
                const output = await buildFile(url.pathToFileURL(id), {
                  config,
                  isDev: true,
                  isSSR: false,
                  isHmrEnabled: false,
                });
                let jsResponse;
                // console.log(output);
                for (const [outputType, outputContents] of Object.entries(output)) {
                  if (jsResponse) {
                    console.log(`load() Err: ${Object.keys(output)}`);
                  }
                  if (!jsResponse || outputType === '.js') {
                    jsResponse = outputContents;
                  }
                }
                return jsResponse;
              },
            } as RollupPlugin,
          ],
        },
      });
      await fs.writeFile(
        path.join(installDest, '.hash'),
        etag(entrypointPackageManifestStr),
        'utf8',
      );
      console.timeEnd(spec);

      const finalLocation = path.posix.join(
        config.buildOptions.metaUrlPath,
        'pkg',
        hash,
        `-`,
        finalResult.importMap.imports[spec],
      );
      return `export * from "${finalLocation}"; export {default} from "${finalLocation}";`;
    });
  },

  modifyBuildInstallOptions({installOptions, config}) {
    if (config.packageOptions.source !== 'local') {
      return installOptions;
    }
    installOptions.cwd = config.root;
    installOptions.rollup = config.packageOptions.rollup;
    installOptions.sourcemap = config.buildOptions.sourcemap;
    installOptions.polyfillNode = config.packageOptions.polyfillNode;
    installOptions.packageLookupFields = config.packageOptions.packageLookupFields;
    installOptions.packageExportLookupFields = config.packageOptions.packageExportLookupFields;
    return installOptions;
  },

  async prepare(commandOptions: CommandOptions) {
    config = commandOptions.config;
    installTargets = await getInstallTargets(config, []);
    // const {config} = commandOptions;
    // Set the proper install options, in case an install is needed.
    // logger.debug(`Using cache folder: ${path.relative(config.root, DEV_DEPENDENCIES_DIR)}`);
    // installOptions = merge(commandOptions.config.packageOptions as PackageSourceLocal, {
    //   dest: DEV_DEPENDENCIES_DIR,
    //   env: {NODE_ENV: process.env.NODE_ENV || 'development'},
    //   treeshake: false,
    // });
    // Start with a fresh install of your dependencies, if needed.
    // const dependencyImportMapLoc = path.join(DEV_DEPENDENCIES_DIR, 'import-map.json');
    // let dependencyImportMap = {imports: {}};
    // try {
    //   dependencyImportMap = JSON.parse(
    //     await fs.readFile(dependencyImportMapLoc, {encoding: 'utf8'}),
    //   );
    // } catch (err) {
    //   // no import-map found, safe to ignore
    // }
    // if (!(await checkLockfileHash(DEV_DEPENDENCIES_DIR)) || !existsSync(dependencyImportMapLoc)) {
    //   logger.debug('Cache out of date or missing. Updating...');
    //   // const installResult = await installDependencies(config);
    //   // dependencyImportMap = installResult?.importMap || {imports: {}};
    // } else {
    //   logger.debug(`Cache up-to-date. Using existing cache`);
    // }
  },

  resolvePackageImport(source: string, spec: string, config: SnowpackConfig): string | false {
    const entrypoint = resolveEntrypoint(spec, {
      cwd: path.dirname(source),
      packageLookupFields: ['svelte'],
    });
    const rootPackageDirectory = getRootPackageDirectory(entrypoint);
    const entrypointPackageManifestLoc = path.join(rootPackageDirectory, 'package.json');
    const entrypointPackageManifest = JSON.parse(
      readFileSync(entrypointPackageManifestLoc!, 'utf8'),
    );

    const hash =
      'local' +
      ':' +
      crypto.createHash('md5').update(rootPackageDirectory).digest('hex').substr(0, 12);
    allHashes[hash] = rootPackageDirectory;

    // const installDest = path.join(
    //   DEV_DEPENDENCIES_DIR,
    //   entrypointPackageManifest.name + '@' + entrypointPackageManifest.version,
    // );
    // const importMap =
    //   existsSync(installDest) &&
    //   JSON.parse(readFileSync(path.join(installDest, 'import-map.json'), 'utf8')!);
    // console.log('AAA', importMap, spec);
    // if (importMap && importMap.imports[spec]) {
    //   return path.posix.join(
    //     config.buildOptions.metaUrlPath,
    //     'pkg',
    //     hash,
    //     '-',
    //     importMap.imports[spec],
    //   );
    // }

    // if (spec === 'svelte' || spec.startsWith('svelte/')) {
    //   return path.posix.join(
    //     config.buildOptions.metaUrlPath,
    //     'pkg',
    //     hash.replace('local:', 'raw:'),
    //     entrypoint.replace(rootPackageDirectory, 'svelte'),
    //   );
    // }
    // if (spec === 'svelte-awesome' || spec.startsWith('svelte-awesome/')) {
    //   return path.posix.join(
    //     config.buildOptions.metaUrlPath,
    //     'pkg',
    //     hash.replace('local:', 'raw:'),
    //     entrypoint.replace(rootPackageDirectory, 'svelte-awesome'),
    //   );
    // }

    return path.posix.join(config.buildOptions.metaUrlPath, 'pkg', hash, spec);
  },

  // async recoverMissingPackageImport(_, config): Promise<ImportMap> {
  //   logger.info(colors.yellow('Dependency cache out of date. Updating...'));
  //   const installResult = await installDependencies(config);
  //   const dependencyImportMap = installResult!.importMap;
  //   return dependencyImportMap;
  // },

  clearCache() {
    return rimraf.sync(PROJECT_CACHE_DIR);
  },

  getCacheFolder() {
    return PROJECT_CACHE_DIR;
  },
} as PackageSource;
