import crypto from 'crypto';
import {install as esinstall, InstallTarget, resolveEntrypoint} from 'esinstall';
import projectCacheDir from 'find-cache-dir';
import validatePackageName from 'validate-npm-package-name';
import findUp from 'find-up';
import {existsSync, promises as fs, readFileSync} from 'fs';
import PQueue from 'p-queue';
import path from 'path';
import rimraf from 'rimraf';
import util from 'util';
import {logger} from '../logger';
import {transformEsmImports} from '../rewrite-imports';
import {getInstallTargets} from '../scan-imports';
import {CommandOptions, PackageSource, SnowpackConfig} from '../types';
import {GLOBAL_CACHE_DIR, replaceExtension} from '../util';
import {getBuiltFileUrl} from '../build/file-urls';

const PROJECT_CACHE_DIR =
  projectCacheDir({name: 'snowpack'}) ||
  // If `projectCacheDir()` is null, no node_modules directory exists.
  // Use the current path (hashed) to create a cache entry in the global cache instead.
  // Because this is specifically for dependencies, this fallback should rarely be used.
  path.join(GLOBAL_CACHE_DIR, crypto.createHash('md5').update(process.cwd()).digest('hex'));

const DEV_DEPENDENCIES_DIR = path.join(PROJECT_CACHE_DIR, process.env.NODE_ENV || 'development');

function getWebDependencyName(dep: string): string {
  return validatePackageName(dep).validForNewPackages
    ? dep.replace(/\.js$/i, 'js') // if this is a top-level package ending in .js, replace with js (e.g. tippy.js -> tippyjs)
    : dep.replace(/\.m?js$/i, ''); // otherwise simply strip the extension (Rollup will resolve it)
}

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
  console.log(packageRoot, packageParts);
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
const allSpecs: Record<string, string> = {};
const inProgress = new PQueue({concurrency: 1});
/**
 * Local Package Source: A generic interface through which Snowpack
 * interacts with esinstall and your locally installed dependencies.
 */
export default {
  async load(id: string): Promise<Buffer> {
    const idParts = id.split('/');
    idParts.shift();
    let packageInfo = idParts.shift()!;
    if (packageInfo?.startsWith('@')) {
      packageInfo += '/' + idParts.shift();
    }
    const hash = idParts.shift()!;
    const packageInfoParts = packageInfo.split('@');
    const packageVersion = packageInfoParts.pop()!;
    const packageName = packageInfoParts.join('@');
    const spec = allSpecs[idParts.join('/')];
    const entrypoint = allHashes[hash];
    const installDest = path.join(DEV_DEPENDENCIES_DIR, packageInfo);

    console.log(allSpecs, idParts, spec);
    return inProgress.add(async () => {
      let installEntrypoints = [
        spec,
        ...installTargets
          .map((t) => t.specifier)
          .filter((t) => t !== spec && (t === packageName || t.startsWith(packageName + '/'))),
      ];
      console.log('installEntrypoints', packageName, installTargets, installEntrypoints);
      let dependencyFileLoc: string | undefined;
      console.time(spec);
      if (existsSync(installDest)) {
        const importMap = JSON.parse(
          (await fs.readFile(path.join(installDest, 'import-map.json'), 'utf8'))!,
        );
        installEntrypoints = Object.keys(importMap.imports);
        if (importMap.imports[spec]) {
          dependencyFileLoc = path.join(installDest, importMap.imports[spec]);
        } else {
          installEntrypoints.push(spec);
        }
      }
      const entrypointPackageManifestLoc = (await findUp('package.json', {
        cwd: path.dirname(entrypoint),
      })) as string;
      const entrypointPackageManifest = JSON.parse(
        await fs.readFile(entrypointPackageManifestLoc, 'utf8'),
      );
      if (!dependencyFileLoc) {
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
        });
        dependencyFileLoc = path.join(installDest, finalResult.importMap.imports[spec]);
      }
      console.timeEnd(spec);
      const installedPackageCode = await fs.readFile(dependencyFileLoc!, 'utf8');
      // TODO: Always pass the result through our normal build pipeline, for unbundled packages and such
      const processedCode = await transformEsmImports(installedPackageCode, (_spec) => {
        if (_spec.startsWith('./') || _spec.startsWith('../')) {
          return _spec;
        }
        return this.resolvePackageImport(entrypointPackageManifestLoc, _spec, config) as string;
      });
      return Buffer.from(processedCode);
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
    console.log('START', spec, source);
    const entrypoint = resolveEntrypoint(spec, {
      cwd: path.dirname(source),
      packageLookupFields: [],
    });
    const rootPackageDirectory = getRootPackageDirectory(entrypoint);
    console.log('rootPackageDirectory', rootPackageDirectory);
    const entrypointPackageManifestLoc = path.join(rootPackageDirectory, 'package.json');
    const entrypointPackageManifest = JSON.parse(
      readFileSync(entrypointPackageManifestLoc!, 'utf8'),
    );
    const hash = crypto.createHash('md5').update(rootPackageDirectory).digest('hex');
    const builtAsset = getBuiltFileUrl(entrypoint, config);
    const finalSpec = replaceExtension(spec, path.extname(spec), path.extname(builtAsset));
    allHashes[hash] = entrypoint;
    allSpecs[finalSpec] = spec;
    return path.posix.join(
      config.buildOptions.metaUrlPath,
      'pkg',
      'local',
      `${entrypointPackageManifest.name}@${entrypointPackageManifest.version}`,
      hash,
      finalSpec,
    );
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
