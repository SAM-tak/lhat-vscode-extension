// Keep ELK's complete worker in one local bundle: webviews cannot load its
// dependencies through importScripts. Its native worker protocol is handled
// by elk-api on the UI side.
import "elkjs/lib/elk-worker.min.js";
