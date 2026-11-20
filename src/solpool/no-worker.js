// Proving runs single-threaded inside a worker of its own; ffjavascript's thread pool is never started. Its
// web-worker library would take this worker for one of its own threads, so it is left out of the bundle.
module.exports = class NoWorker { constructor() { throw new Error('Threads are not used here.'); } };
