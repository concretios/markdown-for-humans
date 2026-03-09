// Global type definitions for VS Code Webview API

/**
 * A standard interface for the VS Code Webview API.
 * This is provided by the un-mocked VS Code extension host environment.
 */
interface WebviewApi<StateType> {
  postMessage(message: unknown): void;
  getState(): StateType | undefined;
  setState(newState: StateType): void;
}

/**
 * Global function available in VS Code webviews to acquire the API instance.
 * Warning: this function can only be called once per webview!
 */
declare function acquireVsCodeApi<StateType = unknown>(): WebviewApi<StateType>;
