import {
  DependencyStatsOutput,
  install,
  InstallOptions as EsinstallOptions,
  InstallTarget,
  printStats,
} from 'esinstall';
import * as colors from 'kleur/colors';
import {performance} from 'perf_hooks';
import util from 'util';
import url from 'url';
import {buildFile} from '../build/build-pipeline';
import {logger} from '../logger';
import {ImportMap, SnowpackConfig} from '../types';

interface InstallRunOptions {
  config: SnowpackConfig;
  installOptions: EsinstallOptions;
  installTargets: InstallTarget[];
  shouldPrintStats: boolean;
}

interface InstallRunResult {
  importMap: ImportMap;
  newLockfile: ImportMap | null;
  stats: DependencyStatsOutput | null;
}

export async function run({
  config,
  installOptions,
  installTargets,
  shouldPrintStats,
}: InstallRunOptions): Promise<InstallRunResult> {
  if (installTargets.length === 0) {
    return {
      importMap: {imports: {}} as ImportMap,
      newLockfile: null,
      stats: null,
    };
  }
  // start
  const installStart = performance.now();
  logger.info(colors.yellow('! building dependencies...'));

  let newLockfile: ImportMap | null = null;
  const finalResult = await install(installTargets, {
    cwd: config.root,
    importMap: newLockfile || undefined,
    alias: config.alias,
    logger: {
      debug: (...args: [any, ...any[]]) => logger.debug(util.format(...args)),
      log: (...args: [any, ...any[]]) => logger.info(util.format(...args)),
      warn: (...args: [any, ...any[]]) => logger.warn(util.format(...args)),
      error: (...args: [any, ...any[]]) => logger.error(util.format(...args)),
    },
    ...installOptions,
    rollup: {
      plugins: [
        {
          name: 'esinstall:snowpack',
          async load(id: string) {
            console.log('load()', id);
            const output = await buildFile(url.pathToFileURL(id), {
              config,
              isDev: true,
              isSSR: config.buildOptions.ssr,
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
        },
      ],
    },
  });
  logger.debug('Successfully ran esinstall.');

  // finish
  const installEnd = performance.now();
  logger.info(
    `${colors.green(`✔`) + ' dependencies ready!'} ${colors.dim(
      `[${((installEnd - installStart) / 1000).toFixed(2)}s]`,
    )}`,
  );

  if (shouldPrintStats && finalResult.stats) {
    logger.info(printStats(finalResult.stats));
  }

  return {
    importMap: finalResult.importMap,
    newLockfile,
    stats: finalResult.stats!,
  };
}
