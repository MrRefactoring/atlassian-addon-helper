import { Request, Response, NextFunction } from 'express';
import createDebugger from 'debug';
import * as jwt from 'atlassian-jwt';
import moment from 'moment';
import _ from 'lodash';
import requestHandler from './request';
import { AtlassianAddon } from '.';

export const logger = createDebugger('nexus:jira:auth');

const TOKEN_KEY_PARAM = 'acpt';
const TOKEN_KEY_HEADER = 'X-' + TOKEN_KEY_PARAM;

const JWT_PARAM = 'jwt';
const AUTH_HEADER = 'authorization'; // the header name appears as lower-case

/**
 * By default, export the function call which returns the request handler.
 */
export default (descriptor: AtlassianAddon) => {
    return (req: Request, res: Response, next: NextFunction) => {
        authenticate(descriptor)(req, res, () => {
            return next();
        });
    };
};

const authenticate = (addon?: AtlassianAddon) => {

    return async (req: Request, res: Response, next: NextFunction) => {

        const sendError = (code: number,  msg: string) => {
            res.status(code).json({code,msg});
        };

        if (/no-auth/.test(process.env.AC_OPTS)) {
            logger('Auth verification is disabled, skipping validation of request.');
            next();
            return;
        }

        const token = extractJwtFromRequest(req);
        if (!token) {
            sendError(401, 'Could not find authentication data on request');
            return;
        }

        let unverifiedClaims: any;
        try {
            unverifiedClaims = jwt.decode(token, '', true); // decode without verification;
        } catch (e) {
            sendError(401, 'Invalid JWT: ' + e.message);
            return;
        }

        const issuer = unverifiedClaims.iss;
        if (!issuer) {
            sendError(401, 'JWT claim did not contain the issuer (iss) claim');
            return;
        }

        let clientKey = issuer;

        // The audience claim identifies the intended recipient, according to the JWT spec,
        // but we still allow the issuer to be used if 'aud' is missing.
        // Session JWTs make use of this (the issuer is the add-on in this case)
        if (!_.isEmpty(unverifiedClaims.aud)) {
            clientKey = unverifiedClaims.aud[0];
        }

        const success = async (vc: any) => {
            const t = await createSessionToken(vc);
            // Invoke the request middleware (again) with the verified and trusted parameters

            // Base params
            const verifiedParams: Record<string, any> = {
                clientKey,
                hostBaseUrl: addon.baseUrl,
                token: t,
                context: undefined
            };

            // Use the context.user if it exists. This is deprecated as per
            // https://ecosystem.atlassian.net/browse/AC-2424
            if (vc.context) {
                verifiedParams.context = vc.context;
                const user = vc.context.user;
                if (user) {
                    if (user.accountId) {
                        verifiedParams.userAccountId = user.accountId;
                    }
                    if (user.userKey) {
                        verifiedParams.userKey = user.userKey;
                    }
                }
            }

            if (!verifiedParams.userAccountId) {
                // Otherwise use the sub claim, and assume it to be the AAID.
                // It will not be the AAID if they haven't opted in / if its before
                // the end of the deprecation period, but in that case context.user
                // will be used instead.
                verifiedParams.userAccountId = vc.sub;
            }

            const reqHandler = requestHandler(addon.app, verifiedParams);
            reqHandler(req, res, next);
        };

        // Create a JWT token that can be used instead of a session cookie
        const createSessionToken = async (vc: any) => {
            const now = moment().utc();

            const baseJwt: Record<string, any> = {
                'iss': addon.key,
                'iat': now.unix(),
                'sub': vc.sub,
                'exp': now.add(addon.maxTokenAge, 'milliseconds').unix(),
                'aud': [clientKey]
            };

            // If the context.user exists, then send that too. This is to handle
            // the interim period swapover from userKey to userAccountId.
            if (vc.context) {
                baseJwt.context = vc.context;
            }

            const innerToken = jwt.encode(baseJwt, await addon.getSharedSecret(clientKey));
            res.setHeader(TOKEN_KEY_HEADER, innerToken);
            return innerToken;
        };

        const secret = await addon.getSharedSecret(clientKey);
        if (!secret) {
            sendError(401, 'Could not find JWT sharedSecret in' +
                ' stored client data for ' + clientKey);
            return;
        }

        let verifiedClaims: Record<string, any>;
        try {
            verifiedClaims = jwt.decode(token, secret, false);
        } catch (error) {
            sendError(400, 'Unable to decode JWT token: ' + error);
            return;
        }

        // todo build in leeway?
        if (verifiedClaims.exp && moment().utc().unix() >= verifiedClaims.exp) {
            sendError(401, 'Authentication request has expired. Try reloading the page.');
            return;
        }

        // First check query string params
        const jwtRequest = jwt.fromExpressRequest(req);
        if (!addon.skipQshVerification && verifiedClaims.qsh) {
            let expectedHash = jwt.createQueryStringHash(jwtRequest, false, addon.baseUrl);
            let signatureHashVerified = verifiedClaims.qsh === expectedHash;
            if (!signatureHashVerified) {
                let canonicalRequest = jwt.createCanonicalRequest(jwtRequest, false, addon.baseUrl);

                // If that didn't verify, it might be a post/put - check the request body too
                expectedHash = jwt.createQueryStringHash(jwtRequest, true, addon.baseUrl);
                signatureHashVerified = verifiedClaims.qsh === expectedHash;

                if (!signatureHashVerified) {
                    canonicalRequest = jwt.createCanonicalRequest(jwtRequest, true, addon.baseUrl);

                    // Send the error message for the first verification - it's 90% more likely to be the one we want.
                    logger(
                        'Auth failure: Query hash mismatch: Received: "' + verifiedClaims.qsh + '" but calculated "' + expectedHash + '". ' +
                        'Canonical query was: "' + canonicalRequest);
                    sendError(401, 'Authentication failed: ' +
                        'query hash does not match.');

                    return;
                }
            }
        }

        await success(verifiedClaims);
    };
};

// function sendError(code: any, msg: any, next: NextFunction, ctx: any = {}) {
//     logger(ctx, `Authentication verification error (${code}):  ${msg}`);
//     next({
//         code,
//         message: msg
//     });
// }

function extractJwtFromRequest(req: Request) {
    const tokenInQuery = req.query[JWT_PARAM];

    // JWT is missing in query and we don't have a valid body.
    if (!tokenInQuery && !req.body) {
        logger(
            'Cannot find JWT token in query parameters. ' +
            'Please include body-parser middleware and parse the urlencoded body ' +
            '(See https://github.com/expressjs/body-parser) if the add-on is rendering in POST mode. ' +
            'Otherwise please ensure the ' + JWT_PARAM + ' parameter is presented in query.');
        return;
    }

    // JWT appears in both parameter and body will result query hash being invalid.
    const tokenInBody = req.body[JWT_PARAM];
    if (tokenInQuery && tokenInBody) {
        logger('JWT token can only appear in either query parameter or request body.');
        return;
    }
    let token = tokenInQuery || tokenInBody;

    // if there was no token in the query-string then fall back to checking the Authorization header
    const authHeader = req.headers[AUTH_HEADER];
    if (authHeader && authHeader.indexOf('JWT ') === 0) {
        if (token) {
            const foundIn = tokenInQuery ? 'query' : 'request body';
            logger('JWT token found in ' + foundIn + ' and in header: using ' + foundIn + ' value.');
        } else {
            token = authHeader.substring(4);
        }
    }

    // TODO: Remove when we discontinue the old token middleware
    if (!token) {
        token = req.query[TOKEN_KEY_PARAM] || req.header(TOKEN_KEY_HEADER);
    }

    return token;
}
