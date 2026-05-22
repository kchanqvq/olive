import * as vscode from 'vscode';
import * as assert from 'assert';
import * as path from 'path';

describe('Swank E2E Indentation Test', () => {
    it('should indent indent-sample-swank.lisp correctly', async function() {
        this.timeout(60000); // 1 minute for this E2E test

        // 1. Activate extension
        const extension = vscode.extensions.getExtension('undefined_publisher.olive');
        if (!extension) {
            throw new Error('Extension "undefined_publisher.olive" not found');
        }
        await extension.activate();

        // 2. Wait for Lisp/Swank to initialize
        console.log('Waiting 5 seconds for Lisp/Swank to start...');
        await new Promise(resolve => setTimeout(resolve, 5000));

        // 3. Open the sample file
        const samplePath = path.join(__dirname, '../../src/test/indent-sample-swank.lisp');
        const uri = vscode.Uri.file(samplePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const groundTruth = doc.getText().split(/\r?\n/);

        // 4. Trigger formatting
        console.log('Triggering formatting...');
        const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
            'vscode.executeFormatDocumentProvider',
            uri
        );

        if (edits && edits.length > 0) {
            console.log(`Applying ${edits.length} edits...`);
            const workspaceEdit = new vscode.WorkspaceEdit();
            workspaceEdit.set(uri, edits);
            const success = await vscode.workspace.applyEdit(workspaceEdit);
            assert.strictEqual(success, true, 'Failed to apply edits');
        } else {
            console.log('No edits returned by formatter.');
        }

        // 5. Verify against ground truth line by line
        const finalLines = doc.getText().split(/\r?\n/);
        let matchCount = 0;
        let discrepancies = 0;
        const totalLines = groundTruth.length;

        for (let i = 0; i < totalLines; i++) {
            const expected = groundTruth[i];
            const actual = finalLines[i] || '';

            if (expected === actual) {
                matchCount++;
            } else {
                discrepancies++;
                if (discrepancies <= 100) {
                    console.log(`Discrepancy at line ${i + 1}:`);
                    console.log(`  Expected: "${expected}"`);
                    console.log(`  Actual:   "${actual}"`);
                }
            }
        }

        const successRate = (matchCount / totalLines) * 100;
        console.log(`\nSummary:`);
        console.log(`  Total lines:    ${totalLines}`);
        console.log(`  Matching lines: ${matchCount}`);
        console.log(`  Discrepancies:  ${discrepancies}`);
        console.log(`  Success rate:   ${successRate.toFixed(2)}%`);

        if (discrepancies > 100) {
            console.log(`... and ${discrepancies - 100} more discrepancies hidden.`);
        }
        assert.ok(discrepancies <= 79, `Found ${discrepancies} indentation discrepancies.`)
    });
});
