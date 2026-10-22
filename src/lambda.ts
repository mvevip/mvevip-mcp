import serverless from 'serverless-http';
import app from './index';
import { runAdminCommand, AdminRequest } from './admin/adminCommands';

const httpHandler = serverless(app);

/**
 * Además de las peticiones HTTP (Function URL), acepta invocaciones directas autenticadas por IAM:
 *   aws lambda invoke --function-name mvevip-mcp-server \
 *     --payload '{"mvevipAdmin":{"command":"list-users"}}' --cli-binary-format raw-in-base64-out out.json
 * Las peticiones de Internet no pueden incluir `mvevipAdmin`: AWS construye el evento HTTP.
 */
export const handler = async (event: any, context: any) => {
  if (event && typeof event === 'object' && event.mvevipAdmin && !event.requestContext) {
    try {
      return await runAdminCommand(event.mvevipAdmin as AdminRequest);
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) };
    }
  }
  return httpHandler(event, context);
};
