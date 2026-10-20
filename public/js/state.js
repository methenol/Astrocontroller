/** What the server last told us, shared by the screens. */
export const state = {
  /** the telescope state (from 'telescope' messages) */
  telescope: null,
  /** the agent status */
  agent: null,
  /** the duty loop status */
  duty: null,
  /** server config: telescopeHost, observer, minAltitude… */
  config: null,
  /** the chat history */
  history: [],
  /** transfer jobs by id */
  jobs: new Map(),
  /** processing items by id */
  proc: new Map(),
  procInfo: null,
  /** images attached to the next prompt: {data, mimeType} */
  attachments: [],
  /** the source in the main live view */
  mainSrc: 'tele',
};

export const isPanelActive = (name) => document.getElementById(`panel-${name}`)?.classList.contains('active') ?? false;
