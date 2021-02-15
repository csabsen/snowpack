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
import {
  scanCodeImportsExports,
  transformAddMissingDefaultExport,
  transformFileImports,
} from '../rewrite-imports';
import {getInstallTargets} from '../scan-imports';
import {CommandOptions, ImportMap, PackageSource, SnowpackConfig} from '../types';
import {GLOBAL_CACHE_DIR, isRemoteUrl} from '../util';

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

function getRootNodeModulesDirectory(loc: string) {
  const parts = loc.split('node_modules');
  parts.pop()!;
  const packageRoot = path.join(parts.join('node_modules'), 'node_modules');
  return packageRoot;
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

// IDEA:
// maintain mapping outside of this function: installDest => entrypoints
  // this function just reads from it
// maintain set of installDest that need rebuilding: new Set()
// maintain a queue of generic worker, that works through this

const installDestEntrypoints = new Map<string, string>();
const installDestNeedRebuild = new Set<string>();

async function installPackageEntrypoint({
  installDest,
  spec,
  packageManifest,
  packageManifestLoc,
  importMap,
}: {
  installDest: string;
  packageManifest: any;
  packageManifestLoc: string;
  spec: string;
  importMap: ImportMap;
}): Promise<ImportMap> {
  const packageName = packageManifest.name;
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
  console.log(`Installing ${spec}...`);
  // TODO: external should be a function in esinstall
  const external = [
    ...Object.keys(packageManifest.dependencies || {}),
    ...Object.keys(packageManifest.devDependencies || {}),
    ...Object.keys(packageManifest.peerDependencies || {}),
  ];

  const finalResult = await esinstall(installEntrypoints, {
    dest: installDest,
    env: {NODE_ENV: process.env.NODE_ENV || 'development'},
    treeshake: false,
    cwd: packageManifestLoc,
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
  console.log(`Installing ${spec}... DONE`);

  return finalResult.importMap;
}

// A bit of a hack: we keep this in local state and populate it
// during the "prepare" call. Useful so that we don't need to pass
// this implementation detail around outside of this interface.
// Can't add it to the exported interface due to TS.
let config: SnowpackConfig;
let needsDeepResolve = new Set<string>();

let installTargets: InstallTarget[] = [];
const allHashes: Record<
  string,
  {packageName: string; packageVersion: string; entrypoint: string; loc: string}
> = {};
const inProgress = new PQueue({concurrency: 1});
/**
 * Local Package Source: A generic interface through which Snowpack
 * interacts with esinstall and your locally installed dependencies.
 */
export default {
  async load(id: string): Promise<Buffer | string> {
    const PACKAGE_PATH_PREFIX = path.posix.join(config.buildOptions.metaUrlPath, 'pkg/');
    const idParts = id.split('/');
    idParts.shift(); // remove "-"
    const hash = idParts.shift()!;
    const hashParts = hash.split(':');
    let packageName = hashParts.shift()!;
    if (packageName.startsWith('@')) {
      packageName += '/' + hashParts.shift()!;
    }
    const packageVersion = hashParts.shift()!;
    const spec = hashParts.join('/');

    console.log(packageName, packageVersion, spec);
    const {loc, entrypoint} = allHashes[hash];
    let installedPackageCode = await fs.readFile(loc, 'utf8');
    installedPackageCode = await transformAddMissingDefaultExport(installedPackageCode);
    installedPackageCode = await transformFileImports(
      {type: path.extname(loc), contents: installedPackageCode},
      async (spec) => {
        if (isRemoteUrl(spec)) {
          return spec;
        }
        if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
          return spec;
        }
        const resolvedSpecUrl = await this.resolvePackageImport(entrypoint, spec, config);
        return resolvedSpecUrl || spec;
      },
    );
    return installedPackageCode;
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
    const installDirectoryHashLoc = path.join(DEV_DEPENDENCIES_DIR, '.meta');
    const installDirectoryHash = await fs
      .readFile(installDirectoryHashLoc, 'utf-8')
      .catch(() => null);
    if (installDirectoryHash === 'v1') {
      logger.info('Welcome back!');
      return;
    }
    if (installDirectoryHash) {
      logger.info('Welcome back! Updating your dependencies to the latest version of Snowpack...');
    } else {
      logger.info(
        'Welcome to Snowpack! Since this is your first run in this project, we will go ahead and set up your dependencies. This may take a second...',
      );
    }
    const installTargets = await getInstallTargets(
      config,
      config.packageOptions.source === 'local' ? config.packageOptions.knownEntrypoints : [],
    );
    if (installTargets.length === 0) {
      logger.info('Nothing to install.');
      return;
    }
    await Promise.all(
      [...new Set(installTargets.map((t) => t.specifier))].map((spec) =>
        this.resolvePackageImport(path.join(config.root, 'package.json'), spec, config),
      ),
    );
    await fs.writeFile(installDirectoryHashLoc, 'v1', 'utf-8');
    logger.info('Set up complete!');
    return;
  },

  // TODO: Make async, and then clean all of this up
  async resolvePackageImport(source: string, spec: string, config: SnowpackConfig) {
    const entrypoint = resolveEntrypoint(spec, {
      cwd: path.dirname(source),
      packageLookupFields: ['svelte'],
    });
    const rootPackageDirectory = getRootPackageDirectory(entrypoint);
    const packageManifestLoc = path.join(rootPackageDirectory, 'package.json');
    const packageManifestStr = await fs.readFile(packageManifestLoc, 'utf8');
    const packageManifest = JSON.parse(packageManifestStr);
    const newIntegrityHash = etag(packageManifestStr);
    const {name: packageName, version: packageVersion} = packageManifest;
    const installDest = path.join(
      DEV_DEPENDENCIES_DIR,
      packageManifest.name + '@' + packageManifest.version,
    );

    const [isNew, newImportMap] = await inProgress.add(async () => {
      const existingImportMap =
        (await fs.stat(installDest).catch(() => null)) &&
        JSON.parse((await fs.readFile(path.join(installDest, 'import-map.json'), 'utf8'))!);
      const existingIntegrityHash = await fs
        .readFile(path.join(installDest, '.meta'), 'utf-8')
        .catch(() => null);
      const doesInstalledPackageExist = !!existingImportMap;
      const isInstalledPackageStale =
        !doesInstalledPackageExist || newIntegrityHash !== existingIntegrityHash;
      const existingEntrypoint = existingImportMap && existingImportMap.imports[spec];
      console.log(existingEntrypoint, !doesInstalledPackageExist, isInstalledPackageStale);
      if (!isInstalledPackageStale && existingEntrypoint) {
        return [false, existingImportMap];
      }
      return [
        true,
        await installPackageEntrypoint({
          installDest,
          spec,
          packageManifest,
          packageManifestLoc,
          importMap: existingImportMap,
        }),
      ];
    });
    await fs.writeFile(path.join(installDest, '.meta'), newIntegrityHash, 'utf8');
    await inProgress.onIdle();
    const dependencyFileLoc = path.join(installDest, newImportMap.imports[spec]);

    if (isNew) {
      let installedPackageCode = await fs.readFile(dependencyFileLoc!, 'utf8');
      const packageImports = new Set<string>();
      for (const imp of await scanCodeImportsExports(installedPackageCode)) {
        const spec = installedPackageCode.substring(imp.s, imp.e);
        if (isRemoteUrl(spec)) {
          return;
        }
        if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
          return;
        }
        packageImports.add(spec);
      }
      console.log(packageImports);
      await Promise.all(
        [...packageImports].map((packageImport) =>
          this.resolvePackageImport(entrypoint, packageImport, config),
        ),
      );
      await inProgress.onIdle();
    }

    const flattedSpec = newImportMap.imports[spec]
      .replace(/\//g, '.')
      .replace(/^\.+/g, '')
      .replace(/\.([^\.]*?)$/, `.v${packageVersion}.$1`);
      allHashes[flattedSpec] = {packageName, packageVersion, entrypoint, loc: dependencyFileLoc};
    return path.posix.join(config.buildOptions.metaUrlPath, 'pkg', `-`, flattedSpec);
  },

  clearCache() {
    return rimraf.sync(PROJECT_CACHE_DIR);
  },

  getCacheFolder() {
    return PROJECT_CACHE_DIR;
  },
} as PackageSource;
