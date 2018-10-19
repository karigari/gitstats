import {
  APIGatewayEvent,
  Callback,
  Context,
  Handler,
  CustomAuthorizerEvent
} from "aws-lambda";
import * as jwt from "jsonwebtoken";
import authorizer from "./src/authorizer";
import UserManager from "./src/userManager";
import { sendEmail } from "./src/email";
import * as redis from "./src/redis";

const HEADERS = {
  "Access-Control-Allow-Origin": "*", // Required for CORS support to work
  "Access-Control-Allow-Credentials": true // Required for cookies, authorization headers with HTTPS
};

const getToken = (event: APIGatewayEvent) => {
  const { headers } = event;
  const { Authorization } = headers;

  if (!!Authorization) {
    return Authorization.split(" ")[1];
  }
};

const getManager = (event: APIGatewayEvent, owner?: string) => {
  let accessToken = getToken(event);
  const isHomepageRequest = owner === "getsentry";

  if (isHomepageRequest) {
    accessToken = process.env.DEFAULT_ACCESS_TOKEN;
  }

  const decoded: any = jwt.decode(accessToken);
  const { sub: userId } = decoded;
  return new UserManager(userId, owner);
};

const buildResponse = (event, message: any) => {
  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      message,
      input: event
    })
  };
};

const getCacheKey = (path: string, userId: string, weekStart: string) => {
  const suffix = "6";
  return `${userId}-${path}-${weekStart}-${suffix}`;
};

const DEFAULT_CACHE_EXPIRY = 3600 * 24; // in seconds

const getCachedClientResponse = async (
  event: APIGatewayEvent,
  manager: UserManager,
  methodName: string,
  params: any[]
) => {
  // Checks redis first, else calls the client method
  const { path, queryStringParameters } = event;
  const { week_start: weekStart } = queryStringParameters;

  const cacheKey = getCacheKey(path, manager.userId, weekStart);
  const cacheValue = await redis.get(cacheKey);

  if (!!cacheValue) {
    const parsedJson = JSON.parse(cacheValue);
    return parsedJson;
  }

  const client = await manager.getServiceClient(weekStart);
  const response = await client[methodName](...params);
  let writeToCache = true;

  if (methodName === "statistics") {
    const { is_pending } = response;

    // If this is the stats API, and response is pending, we can't
    // write to cache.
    if (is_pending) {
      writeToCache = false;
    }
  }

  if (writeToCache) {
    await redis.set(cacheKey, JSON.stringify(response), DEFAULT_CACHE_EXPIRY);
  }

  return response;
};

export const report: Handler = async (event: APIGatewayEvent) => {
  const { owner } = event.pathParameters;
  const manager = getManager(event, owner);
  const response = await getCachedClientResponse(event, manager, "report", []);
  return buildResponse(event, response);
};

export const stats: Handler = async (event: APIGatewayEvent) => {
  const { owner, repo } = event.pathParameters;
  const manager = getManager(event, owner);
  const response = await getCachedClientResponse(event, manager, "statistics", [
    repo
  ]);
  return buildResponse(event, { repo, stats: response });
};

export const commits: Handler = async (event: APIGatewayEvent) => {
  const { owner } = event.pathParameters;
  const manager = getManager(event, owner);
  const response = await getCachedClientResponse(
    event,
    manager,
    "allCommits",
    []
  );
  return buildResponse(event, response);
};

export const pulls: Handler = async (event: APIGatewayEvent) => {
  const { owner } = event.pathParameters;
  const manager = getManager(event, owner);
  const response = await getCachedClientResponse(
    event,
    manager,
    "prActivity",
    []
  );
  return buildResponse(event, response);
};

export const teamInfo: Handler = async (event: APIGatewayEvent) => {
  const { pathParameters, queryStringParameters } = event;
  const { last_updated: lastUpdated } = queryStringParameters;
  const { owner } = pathParameters;
  const manager = getManager(event, owner);

  const client = await manager.getServiceClient(undefined);
  const response = await client.teamInfo();
  return buildResponse(event, response);
};

export const teams: Handler = async (event: APIGatewayEvent) => {
  const manager = getManager(event);
  const teams = await manager.getServiceTeams();
  return buildResponse(event, teams);
};

export const email: Handler = async (event: APIGatewayEvent) => {
  const body = JSON.parse(event.body);
  const { to, team, week_start: weekStart } = body;
  const manager = getManager(event, team);
  const context = await manager.getEmailContext(weekStart);

  const { subject } = context;
  await sendEmail(to, subject, context);
  return buildResponse(event, {});
};

export const auth: Handler = (
  event: CustomAuthorizerEvent,
  context: Context,
  cb: Callback
) => authorizer(event, cb);
