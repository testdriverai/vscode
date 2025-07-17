# Environment Variables Solution for TestDriver VS Code Extension

## Problem
The `testdriverai` package uses `dotenv` to load environment variables from a `.env` file, but in the VS Code extension context, the current working directory might not be the workspace folder where the user's `.env` file is located. This meant that TestDriver configuration variables in the workspace's `.env` file were not being loaded properly.

## Solution
We've implemented a solution that ensures the TestDriver agent loads environment variables from the correct workspace `.env` file:

### Changes Made

1. **Added dotenv dependency**: Added `dotenv` as a dependency in `package.json`.

2. **Created loadWorkspaceEnv function**: Added a utility function that:
   - Loads the `.env` file from the current workspace folder
   - Handles errors gracefully if the file doesn't exist
   - Logs which TestDriver environment variables were loaded

3. **Modified test execution**: Updated the test runner to call `loadWorkspaceEnv()` before creating the TestDriver agent, ensuring all environment variables are properly loaded.

4. **API Key fallback**: Added fallback logic to check for `TD_API_KEY` in environment variables if it's not found in VS Code secrets.

### How It Works

1. When a test is about to run, the extension calls `loadWorkspaceEnv(workspaceFolder)`
2. This function uses `dotenv.config({ path: workspaceEnvPath })` to load the `.env` file from the workspace root
3. All environment variables from the `.env` file are loaded into `process.env`
4. When the TestDriver agent is created, it will have access to all the correct environment variables

### Supported Environment Variables

The solution supports all TestDriver environment variables, including:

- `TD_API_KEY` - API key for TestDriver Pro
- `TD_VM` - Whether to use a virtual machine
- `TD_ANALYTICS` - Whether to send analytics
- `TD_WEBSITE` - Target website URL
- `TD_MINIMIZE` - Whether to minimize the browser
- `TD_NOTIFY` - Whether to show notifications
- `TD_TYPE` - Type of test (website, desktop, mobile)
- `TD_RESOLUTION` - Screen resolution for tests

### Example .env file

```env
TD_VM=false
TD_API_KEY=your-api-key-here
TD_ANALYTICS=false
TD_WEBSITE=https://example.com
TD_MINIMIZE=false
TD_NOTIFY=true
TD_TYPE=website
TD_RESOLUTION=1366x768
```

### Benefits

1. **Consistent behavior**: TestDriver now behaves the same way in VS Code as it does in the terminal
2. **User-friendly**: Users can configure TestDriver using a familiar `.env` file in their workspace
3. **Flexible**: Supports both VS Code secrets and environment variables for API keys
4. **Robust**: Handles missing files gracefully and provides helpful logging

This solution ensures that the TestDriver VS Code extension properly respects the user's workspace configuration and provides a consistent testing experience.
