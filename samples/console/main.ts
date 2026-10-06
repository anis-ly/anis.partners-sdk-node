import { AnisApiError, UnverifiableResponseError } from '@anis-ly/partners';
import { loadSampleSettings, runSampleCommand } from './commands.ts';

const [command = 'help', ...args] = process.argv.slice(2);

try {
  const exitCode = await runSampleCommand(command, args, await loadSampleSettings());
  if (exitCode !== undefined) process.exitCode = exitCode;
} catch (error) {
  if (error instanceof Error && error.name === 'DryRunStop') {
    console.log(error.message);
    process.exitCode = 0;
  } else if (error instanceof AnisApiError) {
    console.error(
      `Refused: ${error.rawCode ?? error.code} (${String(error.status)}); request ${error.requestId ?? 'unavailable'}.`,
    );
    console.error(`Retryable: ${String(error.isRetryable)}; recorded answer: ${String(error.isReplayed)}.`);
    process.exitCode = 2;
  } else if (error instanceof UnverifiableResponseError) {
    console.error(`Unverifiable response (${error.failure}); response content was discarded.`);
    process.exitCode = 3;
  } else {
    console.error(error instanceof Error ? error.message : 'The command failed.');
    process.exitCode = 1;
  }
}
