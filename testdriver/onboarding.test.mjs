import { test, expect } from 'vitest';
import { TestDriver } from 'testdriverai/vitest/hooks';

test('onboarding walkthrough should guide user through setup', async (context) => {

  const testdriver = TestDriver(context);

  await testdriver.provision.vscode();

  // Verify the getting started walkthrough is visible
  let result = await testdriver.assert(
    'the "Get Started with TestDriver" walkthrough guide is visible in VS Code'
  );
  expect(result).toBeTruthy();

  // Step 1: Get API Key
  result = await testdriver.assert(
    'the first step is "Get a TestDriver API Key"'
  );
  expect(result).toBeTruthy();

  const getApiKeyButton = await testdriver.find(
    'blue "Get API Key" button inside the first walkthrough step'
  );
  await getApiKeyButton.click();

  // Handle the external link dialog
  const openButton = await testdriver.find(
    'blue "Open" button in the VS Code external website dialog'
  );
  await openButton.click();

  // Step 2: Set API Key
  const setApiKeyButton = await testdriver.find(
    '"Set Your API Key" button in the walkthrough'
  );
  await setApiKeyButton.click();

  // Step 3: Install MCP Server
  const installMcpButton = await testdriver.find(
    '"Install MCP Server" button in the walkthrough'
  );
  await installMcpButton.click();

  // Step 4: Open Live Preview
  const livePreviewButton = await testdriver.find(
    '"Open Live Preview" button in the walkthrough'
  );
  await livePreviewButton.click();

  result = await testdriver.assert(
    'the TestDriver Live Preview panel is visible'
  );
  expect(result).toBeTruthy();

});
