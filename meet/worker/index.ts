import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env.js";
import { handleApi, handleCallback, type RecorderApi, type Store } from "./http.js";

export { MeetRecorder } from "./recorder.js";

/** Durable Object RPC stubs wrap results in Rpc.* types; at runtime the shape is RecorderApi. */
const recorderFor = (env: Env, id: string) => env.MEET_RECORDER.getByName(id) as unknown as RecorderApi;

/** Requests from a recording's container to http://meet-recorder.internal arrive here (interceptOutboundHttp). */
export class RecorderCallback extends WorkerEntrypoint<Env, { recordingId: string }> {
  override fetch(request: Request): Promise<Response> {
    const id = this.ctx.props.recordingId;
    const store: Store = async (key, body, contentType) => {
      await this.env.BUCKET.put(key, body, { httpMetadata: { contentType } });
    };
    return handleCallback(request, id, recorderFor(this.env, id), store);
  }
}

export default {
  fetch: (request, env) => handleApi(request, env.RECORDER_TOKEN, (id) => recorderFor(env, id)),
} satisfies ExportedHandler<Env>;
