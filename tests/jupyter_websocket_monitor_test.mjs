import {
  collectJupyterExecuteMessage,
  JUPYTER_RESULT_MARKERS,
  parseJupyterChannelMessage
} from "../workers/factor-ideas/src/jupyter-websocket-monitor.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const msgId = "msg-1";
const streamMsg = {
  parent_header: { msg_id: msgId },
  header: { msg_type: "stream" },
  content: { text: "hello" }
};
const acc = collectJupyterExecuteMessage(streamMsg, msgId, {
  stream: "",
  error: null,
  failed: false,
  idle: false,
  hasResultMarker: false
});
assert(acc.stream === "hello", "stream text captured");

const marker = JUPYTER_RESULT_MARKERS[0];
const markerMsg = {
  parent_header: { msg_id: msgId },
  header: { msg_type: "stream" },
  content: { text: `${marker}{"results":[]}` }
};
const markerAcc = collectJupyterExecuteMessage(markerMsg, msgId, {
  stream: "",
  error: null,
  failed: false,
  idle: false,
  hasResultMarker: false
});
assert(markerAcc.hasResultMarker === true, "result marker detected");

const errorMsg = {
  parent_header: { msg_id: msgId },
  header: { msg_type: "error" },
  content: { traceback: ["Traceback...", "ValueError: boom"] }
};
const errorAcc = collectJupyterExecuteMessage(errorMsg, msgId, {
  stream: "",
  error: null,
  failed: false,
  idle: false,
  hasResultMarker: false
});
assert(errorAcc.failed === true, "error flagged");
assert(errorAcc.error.includes("ValueError"), "traceback captured");

const idleMsg = {
  parent_header: { msg_id: msgId },
  header: { msg_type: "status" },
  content: { execution_state: "idle" }
};
const idleAcc = collectJupyterExecuteMessage(idleMsg, msgId, {
  stream: "",
  error: null,
  failed: false,
  idle: false,
  hasResultMarker: false
});
assert(idleAcc.idle === true, "idle detected");

assert(parseJupyterChannelMessage("{bad json") === null, "invalid json ignored");

console.log("jupyter_websocket_monitor_test: ok");
