import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
    buildShellExportEnvironmentCommand,
    buildShellSetDirectoryCommand,
    joinShellStatements,
    quotePowerShellArg,
    quoteShellArg,
} from './shell.ts';

describe('quoteShellArg', () => {
    it('quotes a simple string', () => {
        assert.strictEqual(quoteShellArg('foo'), "'foo'");
    });

    it('quotes a string with spaces', () => {
        assert.strictEqual(quoteShellArg('foo bar'), "'foo bar'");
    });

    it('quotes a string with single quotes', () => {
        assert.strictEqual(quoteShellArg("don't"), "'don'\\''t'");
    });

    it('quotes an empty string', () => {
        assert.strictEqual(quoteShellArg(''), "''");
    });

    it('quotes a string with multiple single quotes', () => {
        assert.strictEqual(quoteShellArg("it's a 'test'"), "'it'\\''s a '\\''test'\\'''");
    });

    it('quotes a string for PowerShell', () => {
        assert.strictEqual(quoteShellArg("don't", 'powershell'), "'don''t'");
        assert.strictEqual(quotePowerShellArg("it's a 'test'"), "'it''s a ''test'''");
    });
});

describe('buildShellExportEnvironmentCommand', () => {
    it('builds POSIX export commands', () => {
        assert.strictEqual(
            buildShellExportEnvironmentCommand([
                { name: 'OPENAI_API_KEY', value: 'sk-test' },
                { name: 'OPENAI_BASE_URL', value: 'https://example.test/v1' },
            ], 'posix'),
            "export OPENAI_API_KEY='sk-test' OPENAI_BASE_URL='https://example.test/v1'",
        );
    });

    it('builds PowerShell environment commands', () => {
        assert.strictEqual(
            buildShellExportEnvironmentCommand([
                { name: 'OPENAI_API_KEY', value: "don't" },
            ], 'powershell'),
            "$env:OPENAI_API_KEY = 'don''t'",
        );
    });
});

describe('buildShellSetDirectoryCommand', () => {
    it('builds POSIX cd command', () => {
        assert.strictEqual(buildShellSetDirectoryCommand('/tmp/work tree', 'posix'), "cd '/tmp/work tree'");
    });

    it('builds PowerShell Set-Location command', () => {
        assert.strictEqual(
            buildShellSetDirectoryCommand("C:\\Work Tree", 'powershell'),
            "Set-Location -LiteralPath 'C:\\Work Tree'",
        );
    });
});

describe('joinShellStatements', () => {
    it('joins POSIX shell statements with &&', () => {
        assert.strictEqual(joinShellStatements(['echo 1', 'echo 2'], 'posix'), 'echo 1 && echo 2');
    });

    it('joins PowerShell statements with semicolons', () => {
        assert.strictEqual(joinShellStatements(['echo 1', 'echo 2'], 'powershell'), 'echo 1; echo 2');
    });
});
