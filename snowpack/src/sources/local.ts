import crypto from 'crypto';
import {install as esinstall, resolveEntrypoint} from 'esinstall';
import projectCacheDir from 'find-cache-dir';
import {existsSync, promises as fs, readFileSync} from 'fs';
import PQueue from 'p-queue';
import path from 'path';
import rimraf from 'rimraf';
import type {Plugin as RollupPlugin} from 'rollup';
import url from 'url';
import util from 'util';
import {buildFile} from '../build/build-pipeline';
import {logger} from '../logger';
import {
  scanCodeImportsExports,
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

async function installPackageEntrypoint({
  installDest,
  packageManifest,
  packageManifestLoc,
}: {
  installDest: string;
  packageManifest: any;
  packageManifestLoc: string;
}): Promise<ImportMap> {
  let installEntrypoints = [...allKnownSpecs].filter(
    (spec) => spec === packageManifest.name || spec.startsWith(packageManifest.name + '/'),
  );
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
          // resolveId(source: string, importer: string | undefined) {
          // console.log('resolveId()', source);
          //   return source;
          // },
          async load(id: string) {
            // console.log('load()', id);
            const output = await buildFile(url.pathToFileURL(id), {
              config,
              isDev: true,
              isSSR: false,
              isHmrEnabled: false,
            });
            let jsResponse;
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
  return finalResult.importMap;
}

// A bit of a hack: we keep this in local state and populate it
// during the "prepare" call. Useful so that we don't need to pass
// this implementation detail around outside of this interface.
// Can't add it to the exported interface due to TS.
let config: SnowpackConfig;

type FoundHash = {
  entrypoint: string;
  loc: string;
  installDest: string;
  packageVersion: string;
  packageName: string;
};
const allHashes: Record<string, FoundHash> = {};
const inProgress = new PQueue({concurrency: 5});
const inProgressRunning = new Map<string, Promise<ImportMap>>();
const allKnownSpecs = new Set<string>();

/**
 * Local Package Source: A generic interface through which Snowpack
 * interacts with esinstall and your locally installed dependencies.
 */
export default {
  async load(id: string): Promise<Buffer | string> {
    const idParts = id.split('/');
    let foundHash: FoundHash;
    if (idParts.length === 1) {
      const hash = idParts[0];
      foundHash = allHashes[hash]!;
    } else {
      const hash = idParts.join('/');
      foundHash = allHashes[hash]!;
    }
    const {loc, entrypoint, installDest, packageName, packageVersion} = foundHash;
    await inProgress.onIdle();
    let installedPackageCode = await fs.readFile(loc, 'utf8');
    installedPackageCode = await transformFileImports(
      {type: path.extname(loc), contents: installedPackageCode},
      async (spec) => {
        if (isRemoteUrl(spec)) {
          return spec;
        }
        if (spec.startsWith('/')) {
          return spec;
        }
        // These are a bit tricky: 
        if (spec.startsWith('./') || spec.startsWith('../')) {
          const newLoc = path.resolve(path.dirname(loc), spec);
          const resolvedSpec = path.relative(installDest, newLoc);
          const importMap = JSON.parse(
            await fs.readFile(path.join(installDest, 'import-map.json'), 'utf8'),
          );
          const foundEntrypoint = Object.entries(importMap.imports).find(
            ([k, v]) => v === './' + resolvedSpec,
          );
          const hash = path.join(`${packageName}.v${packageVersion}`, resolvedSpec);
          if (!foundEntrypoint) {
            allHashes[hash] = {
              entrypoint: path.join(installDest, 'package.json'),
              loc: newLoc,
              installDest,
              packageVersion,
              packageName,
            };
            return path.posix.join(config.buildOptions.metaUrlPath, 'pkg', hash);
          }
          spec = foundEntrypoint[0];
        }
        return await this.resolvePackageImport(entrypoint, spec, config);
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
    console.time('SYNC');
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
      [...new Set(installTargets.map((t) => t.specifier))].map((spec) => {
        return this.resolvePackageImport(path.join(config.root, 'package.json'), spec, config);
      }),
    );
    await fs.writeFile(installDirectoryHashLoc, 'v1', 'utf-8');
    logger.info('Set up complete!');
    console.timeEnd('SYNC');
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
    const {name: packageName, version: packageVersion} = packageManifest;
    const installDest = path.join(DEV_DEPENDENCIES_DIR, packageName + '@' + packageVersion);

    let isNew = !allKnownSpecs.has(spec);
    allKnownSpecs.add(spec);
    const newImportMap = await inProgress.add(
      async (): Promise<ImportMap> => {
        // If an install is already in progress, wait for that to finish and check that result first.
        // We use a "while" here because many requests to the same package may get backed up here while
        // waiting. If they all fail to match the original on completion, the while loop ensures that
        // only one will
        while (inProgressRunning.has(installDest)) {
          console.log(spec, 'CACHED! (already running)');
          const newImportMap = await inProgressRunning.get(installDest);
          if (newImportMap?.imports[spec]) {
            return newImportMap;
          }
        }

        // Note(fks): The rest of this function must by synchronous, to make sure that multiple builds don't
        // kick off at once. If a build breaks out of the while loop, it must be a straight, syncronous
        // shot to the step below where it re-adds a job to the inProgressRunning map.
        // TODO(fks): There's probably a smarter way to organize this that removes the sync requirement.

        // Look up the import map of the installed package, and check if this specifier now exists.
        const existingImportMapLoc = path.join(installDest, 'import-map.json');
        const existingImportMap =
          existsSync(existingImportMapLoc) &&
          JSON.parse(readFileSync(existingImportMapLoc, 'utf8')!);
        if (existingImportMap && existingImportMap.imports[spec]) {
          console.log(spec, 'CACHED! (already exists)');
          return existingImportMap;
        }
        // Otherwise, kick off a new build!
        console.log(`Installing ${spec}...`);
        const installPackagePromise = installPackageEntrypoint({
          installDest,
          packageManifest,
          packageManifestLoc,
        });
        inProgressRunning.set(installDest, installPackagePromise);
        const newImportMap = await installPackagePromise;
        console.log(`Installing ${spec}... DONE`, Object.keys(newImportMap.imports));
        inProgressRunning.delete(installDest);
        return newImportMap;
      },
    );

    const dependencyFileLoc = path.join(installDest, newImportMap.imports[spec]);
    if (isNew) {
      await inProgress.onIdle();
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
      await Promise.all(
        [...packageImports].map((packageImport) =>
          this.resolvePackageImport(entrypoint, packageImport, config),
        ),
      );
    }

    const flattedSpec = newImportMap.imports[spec]
      .replace(/\//g, '.')
      .replace(/^\.+/g, '')
      .replace(/\.([^\.]*?)$/, `.v${packageVersion}.$1`);
    allHashes[flattedSpec] = {
      entrypoint,
      loc: dependencyFileLoc,
      installDest,
      packageVersion,
      packageName,
    };
    return path.posix.join(config.buildOptions.metaUrlPath, 'pkg', flattedSpec);
  },

  clearCache() {
    return rimraf.sync(PROJECT_CACHE_DIR);
  },

  getCacheFolder() {
    return PROJECT_CACHE_DIR;
  },
} as PackageSource;
