import crypto from 'crypto';
import {resolveEntrypoint} from 'esinstall';
import projectCacheDir from 'find-cache-dir';
import {existsSync, promises as fs} from 'fs';
import PQueue from 'p-queue';
import path from 'path';
import rimraf from 'rimraf';
import {logger} from '../logger';
import {scanCodeImportsExports, transformFileImports} from '../rewrite-imports';
import {getInstallTargets} from '../scan-imports';
import {CommandOptions, ImportMap, PackageSource, SnowpackConfig} from '../types';
import {GLOBAL_CACHE_DIR, isJavaScript, isRemoteUrl} from '../util';
import {installPackages} from './local-install';

const PROJECT_CACHE_DIR =
  projectCacheDir({name: 'snowpack'}) ||
  // If `projectCacheDir()` is null, no node_modules directory exists.
  // Use the current path (hashed) to create a cache entry in the global cache instead.
  // Because this is specifically for dependencies, this fallback should rarely be used.
  path.join(GLOBAL_CACHE_DIR, crypto.createHash('md5').update(process.cwd()).digest('hex'));

const DEV_DEPENDENCIES_DIR = path.join(PROJECT_CACHE_DIR, process.env.NODE_ENV || 'development');

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

type PackageImportData = {
  entrypoint: string;
  loc: string;
  installDest: string;
  packageVersion: string;
  packageName: string;
};
const allPackageImports: Record<string, PackageImportData> = {};
const allKnownSpecs = new Set<string>();
const inProgressBuilds = new PQueue({concurrency: 1});

/**
 * Local Package Source: A generic interface through which Snowpack
 * interacts with esinstall and your locally installed dependencies.
 */
export default {
  async load(id: string, isSSR: boolean): Promise<Buffer | string> {
    const packageImport = allPackageImports[id];
    const {loc, entrypoint, packageName, packageVersion} = packageImport;
    let {installDest} = packageImport;
    if (isSSR && existsSync(installDest + '-ssr')) {
      installDest += '-ssr';
    }

    // Wait for any in progress builds to complete, in case they've
    // cleared out the directory that you're trying to read out of.
    await inProgressBuilds.onIdle();
    let packageCode = await fs.readFile(loc, 'utf8');
    const packageImportMap = JSON.parse(
      await fs.readFile(path.join(installDest, 'import-map.json'), 'utf8'),
    );
    packageCode = await transformFileImports(
      {type: path.extname(loc), contents: packageCode},
      async (spec): Promise<string> => {
        if (isRemoteUrl(spec)) {
          return spec;
        }
        if (spec.startsWith('/')) {
          return spec;
        }
        // These are a bit tricky: relative paths within packages always point to
        // relative files within the built package (ex: 'pkg/common/XXX-hash.js`).
        // We resolve these to a new kind of "internal" import URL that's different
        // from the normal, flattened URL for public imports.
        if (spec.startsWith('./') || spec.startsWith('../')) {
          const newLoc = path.resolve(path.dirname(loc), spec);
          const resolvedSpec = path.relative(installDest, newLoc);
          const publicImportEntry = Object.entries(packageImportMap.imports).find(
            ([, v]) => v === './' + resolvedSpec,
          );
          // If this matches the destination of a public package import, resolve to it.
          if (publicImportEntry) {
            spec = publicImportEntry[0];
            return await this.resolvePackageImport(entrypoint, spec, config);
          }
          // Otherwise, create a relative import ID for the internal file.
          const relativeImportId = path.join(`${packageName}.v${packageVersion}`, resolvedSpec);
          allPackageImports[relativeImportId] = {
            entrypoint: path.join(installDest, 'package.json'),
            loc: newLoc,
            installDest,
            packageVersion,
            packageName,
          };
          return path.posix.join(config.buildOptions.metaUrlPath, 'pkg', relativeImportId);
        }
        // Otherwise, resolve this specifier as an external package.
        return await this.resolvePackageImport(entrypoint, spec, config);
      },
    );
    return packageCode;
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
    const [newImportMap, loadedFile] = await inProgressBuilds.add(
      async (): Promise<[ImportMap, Buffer]> => {
        // Look up the import map of the already-installed package.
        // If spec already exists, then this import map is valid.
        const existingImportMapLoc = path.join(installDest, 'import-map.json');
        const existingImportMap =
          (await fs.stat(existingImportMapLoc).catch(() => null)) &&
          JSON.parse(await fs.readFile(existingImportMapLoc, 'utf8'));
        if (existingImportMap && existingImportMap.imports[spec]) {
          console.log(spec, 'CACHED! (already exists)');
          const dependencyFileLoc = path.join(installDest, existingImportMap.imports[spec]);
          return [existingImportMap, await fs.readFile(dependencyFileLoc!)];
        }
        // Otherwise, kick off a new build to generate a fresh import map.
        console.log(`Installing ${spec}...`);

        const installTargets = [...allKnownSpecs].filter(
          (spec) => spec === packageManifest.name || spec.startsWith(packageManifest.name + '/'),
        );

        // TODO: external should be a function in esinstall
        const externalPackages = [
          ...Object.keys(packageManifest.dependencies || {}),
          ...Object.keys(packageManifest.devDependencies || {}),
          ...Object.keys(packageManifest.peerDependencies || {}),
        ];
        const installOptions = {
          dest: installDest,
          cwd: packageManifestLoc,
          env: {NODE_ENV: process.env.NODE_ENV || 'development'},
          treeshake: false,
          external: externalPackages,
          externalEsm: externalPackages,
        };
        const {importMap: newImportMap, needsSsrBuild} = await installPackages({
          config,
          isDev: true,
          isSSR: false,
          installTargets,
          installOptions,
        });
        console.log(`Installing ${spec}... DONE`, Object.keys(newImportMap.imports));
        if (needsSsrBuild) {
          console.log(`Installing ${spec} (ssr)...`);
          await installPackages({
            config,
            isDev: true,
            isSSR: true,
            installTargets,
            installOptions: {
              ...installOptions,
              dest: installDest + '-ssr',
            },
          });
          console.log(`Installing ${spec} (ssr)... DONE`);
        }
        const dependencyFileLoc = path.join(installDest, newImportMap.imports[spec]);
        return [newImportMap, await fs.readFile(dependencyFileLoc!)];
      },
    );

    const dependencyFileLoc = path.join(installDest, newImportMap.imports[spec]);
    if (isNew && isJavaScript(dependencyFileLoc)) {
      await inProgressBuilds.onIdle();
      const packageImports = new Set<string>();
      const code = loadedFile.toString('utf8');
      for (const imp of await scanCodeImportsExports(code)) {
        const spec = code.substring(imp.s, imp.e);
        if (isRemoteUrl(spec)) {
          return;
        }
        if (spec.startsWith('/') || spec.startsWith('./') || spec.startsWith('../')) {
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

    // Flatten the import map value into a resolved, public import ID.
    // ex: "./react.js" -> "react.v17.0.1.js"
    const importId = newImportMap.imports[spec]
      .replace(/\//g, '.')
      .replace(/^\.+/g, '')
      .replace(/\.([^\.]*?)$/, `.v${packageVersion}.$1`);
    allPackageImports[importId] = {
      entrypoint,
      loc: dependencyFileLoc,
      installDest,
      packageName,
      packageVersion,
    };
    return path.posix.join(config.buildOptions.metaUrlPath, 'pkg', importId);
  },

  clearCache() {
    return rimraf.sync(PROJECT_CACHE_DIR);
  },

  getCacheFolder() {
    return PROJECT_CACHE_DIR;
  },
} as PackageSource;
