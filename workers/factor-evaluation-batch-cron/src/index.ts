export interface Env {
  GITHUB_REPO: string;
  GITHUB_WORKFLOW_FILE: string;
  MAX_IDEAS: string;
  SAMPLE_START: string;
  FORCE: string;
  GITHUB_PAT: string;
}

function readGithubPat(env: Env): string {
  const token = env.GITHUB_PAT?.trim();
  if (!token) {
    throw new Error("GITHUB_PAT 未配置，请设置 Worker Secret");
  }
  return token;
}

async function dispatchFactorEvaluationBatchWorkflow(
  env: Env,
  githubPat: string,
): Promise<Response> {
  const [owner, repo] = env.GITHUB_REPO.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPO: ${env.GITHUB_REPO}`);
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${env.GITHUB_WORKFLOW_FILE}/dispatches`;
  return fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubPat}`,
      "Content-Type": "application/json",
      "User-Agent": "quant-factors-factor-evaluation-cron",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      ref: "main",
      inputs: {
        max_ideas: env.MAX_IDEAS,
        sample_start: env.SAMPLE_START,
        force: env.FORCE,
      },
    }),
  });
}

async function runScheduledJob(
  env: Env,
): Promise<
  | {
      ok: true;
      repo: string;
      workflow: string;
      inputs: { max_ideas: string; sample_start: string; force: string };
    }
  | { ok: false; error: string }
> {
  try {
    const githubPat = readGithubPat(env);
    const dispatch = await dispatchFactorEvaluationBatchWorkflow(env, githubPat);

    if (dispatch.status === 204) {
      return {
        ok: true,
        repo: env.GITHUB_REPO,
        workflow: env.GITHUB_WORKFLOW_FILE,
        inputs: {
          max_ideas: env.MAX_IDEAS,
          sample_start: env.SAMPLE_START,
          force: env.FORCE,
        },
      };
    }

    const body = await dispatch.text();
    return {
      ok: false,
      error: `GitHub dispatch ${dispatch.status}: ${body.slice(0, 500)}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const result = await runScheduledJob(env);
    if (!result.ok) {
      console.error(result.error);
      throw new Error(result.error);
    }
    console.log(JSON.stringify(result));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
    }

    const result = await runScheduledJob(env);
    if (!result.ok) {
      return Response.json({ ok: false, error: result.error }, { status: 500 });
    }
    return Response.json({ ok: true, ...result });
  },
};
