#!/usr/bin/env python3
"""Mutation check for the A2A task-store guard (src/a2a/taskStoreGuard.ts).

Reintroduces each defect the guard exists for, runs its tests, and restores
the file byte-for-byte. A mutation whose text is not found exactly once is an
error, not a pass: a substitution that matched nothing leaves the code as it
was and the tests green.

Usage: python3 scripts/mutate-task-store-guard.py [name ...]
Run from anywhere inside the repository, with node_modules installed.
"""
import os
import subprocess
import sys

REPO = subprocess.run(['git', 'rev-parse', '--show-toplevel'],
                      capture_output=True, text=True, check=True).stdout.strip()

GUARD = 'src/a2a/taskStoreGuard.ts'
TESTS = ['tests/a2a/taskStoreGuard.test.ts']

MUTATIONS = [
    {
        # The original crash: the store error reaches the SDK's un-awaited rethrow.
        'name': 'store-rethrows-save-failure',
        'file': GUARD,
        'old': "      this.rememberFailed(task.id);\n",
        'new': "      this.rememberFailed(task.id);\n      throw error;\n",
        'tests': TESTS,
        'expect': 'escaped as an unhandled rejection',
    },
    {
        'name': 'store-rethrows-load-failure',
        'file': GUARD,
        'old': "      this.record({ operation: 'load', taskId, error: asError(raw) });\n      return undefined;",
        'new': "      this.record({ operation: 'load', taskId, error: asError(raw) });\n      throw raw;",
        'tests': TESTS,
        'expect': 'escaped as an unhandled rejection',
    },
    {
        # The store swallows, and nothing tells the caller: a blocking send
        # answers with a task that was never stored.
        'name': 'handler-reports-success-after-failed-save',
        'file': GUARD,
        'old': "      if (isTask(result)) await this.store.markFailed(result);\n      throw storageError(failures);",
        'new': "      if (isTask(result)) await this.store.markFailed(result);",
        'tests': TESTS,
        'expect': 'never the task as a success',
    },
    {
        'name': 'handler-reports-not-found-for-failed-read',
        'file': GUARD,
        'old': "    } catch (error) {\n      if (failures.length > 0) throw storageError(failures);\n      throw error;\n    }\n    if (failures.length > 0) {",
        'new': "    } catch (error) {\n      throw error;\n    }\n    if (failures.length > 0) {",
        'tests': TESTS,
        'expect': 'not "task not found"',
    },
    {
        'name': 'stream-ignores-failed-save',
        'file': GUARD,
        'old': "        if (failures.length > 0) throw storageError(failures);\n        if (step.done) {",
        'new': "        if (step.done) {",
        'tests': TESTS,
        'expect': 'ends the stream with a storage error',
    },
    {
        'name': 'store-forgets-failed-task',
        'file': GUARD,
        'old': "    if (!task || !this.failedTasks.has(taskId) || task.status?.state === 'failed') return task;",
        'new': "    return task;",
        'tests': TESTS,
        'expect': 'later failed saves are logged, not thrown',
    },
    {
        'name': 'store-logs-nothing',
        'file': GUARD,
        'old': "    log.error({\n      action: `a2a.task_store.${failure.operation}_failed`,",
        'new': "    void ({\n      action: `a2a.task_store.${failure.operation}_failed`,",
        'tests': TESTS,
        'expect': 'logs every failed save in full',
    },
    {
        'name': 'server-wires-raw-store',
        'file': 'src/index.ts',
        'old': "    (guardedStore) => new DefaultRequestHandler(agentCard, guardedStore, executor),",
        'new': "    () => new DefaultRequestHandler(agentCard, taskStore, executor),",
        'tests': TESTS,
        'expect': 'the server hands the SDK the guarded store',
    },
]


def run(mutation):
    path = os.path.join(REPO, mutation['file'])
    with open(path, 'rb') as f:
        original = f.read()
    text = original.decode()
    count = text.count(mutation['old'])
    if count != 1:
        return f"ERROR: expected the text once in {mutation['file']}, found {count}"
    try:
        with open(path, 'wb') as f:
            f.write(text.replace(mutation['old'], mutation['new']).encode())
        with open(path, 'rb') as f:
            if f.read() == original:
                return 'ERROR: file unchanged after substitution'
        env = {k: v for k, v in os.environ.items() if k != 'NODE_OPTIONS'}
        proc = subprocess.run(['npx', 'vitest', 'run', '--project', 'unit', *mutation['tests']],
                              cwd=REPO, capture_output=True, text=True, env=env)
        out = proc.stdout + proc.stderr
        if proc.returncode == 0:
            return 'SURVIVED: tests passed with the defect in place'
        if mutation['expect'] not in out:
            return f"ERROR: tests failed, but not on '{mutation['expect']}':\n{out}"
        return 'caught'
    finally:
        with open(path, 'wb') as f:
            f.write(original)
        with open(path, 'rb') as f:
            assert f.read() == original, f"{mutation['file']} not restored"


def main():
    wanted = set(sys.argv[1:])
    failed = False
    for mutation in MUTATIONS:
        if wanted and mutation['name'] not in wanted:
            continue
        result = run(mutation)
        print(f"{mutation['name']}: {result}")
        failed |= result != 'caught'
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
