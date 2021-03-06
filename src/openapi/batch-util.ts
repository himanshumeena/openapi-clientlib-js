import log from '../log';
import { getRequestId, globalToLocalRequestId } from '../utils/request';

const requestRx = /X-Request-Id: ([0-9]+)/;
const httpCodeRx = /HTTP\/1.1 ([0-9]+)/;

const LOG_AREA = 'batch';

/**
 * Parses the response from a batch call.
 *
 * @param responseText - responseText
 * @param parentRequestId - The parent request id. Used as a base for calculating batch items request ids.
 * @returns An array of responses, in the position of the response id's.
 */
function parse(responseText: string, parentRequestId = 0) {
    if (!responseText) {
        throw new Error('Required Parameter: responseText in batch parse');
    }

    const lines = responseText.split('\r\n');
    const responseBoundary = lines[0];
    let currentData: {
        status?: number;
        response?: Record<string, any>;
    } | null = null;
    let requestId = null;
    const responseData = [];
    for (let i = 0, l = lines.length; i < l; i++) {
        const line = lines[i];
        if (line.length) {
            if (requestId === null || !responseData[requestId]) {
                requestId = line.match(requestRx);
                if (requestId) {
                    requestId = parseInt(requestId[1], 10);
                    requestId = globalToLocalRequestId(
                        requestId,
                        parentRequestId,
                    );
                    responseData[requestId] = {};
                }
            }

            if (line.indexOf(responseBoundary) === 0) {
                if (currentData) {
                    requestId =
                        requestId === null ? responseData.length : requestId;
                    responseData[requestId] = currentData;
                }

                requestId = null;
                currentData = {};
            } else if (currentData) {
                if (!currentData.status) {
                    const statusMatch = line.match(httpCodeRx);
                    if (statusMatch) {
                        // change the status to be a number to match fetch
                        currentData.status = Number(statusMatch[1]);
                    }
                } else if (!currentData.response) {
                    const firstCharacter = line.charAt(0);
                    if (
                        firstCharacter === '{' ||
                        firstCharacter === '[' ||
                        firstCharacter === '"'
                    ) {
                        try {
                            currentData.response = JSON.parse(line);
                        } catch (error) {
                            log.error(
                                LOG_AREA,
                                'Unexpected error parsing json',
                                { error, line, requestId },
                            );
                        }
                    }
                }
            }
        }
    }

    return responseData;
}

export interface BatchRequest {
    method: string;
    headers?: Record<string, string>;
    url: string;
    data?: string;
}

/**
 * Builds up a string of the data for a batch request.
 *
 * @param subRequests - The sub requests of the batch.
 * @param host - The host of the sender.
 *
 */
function build(subRequests: BatchRequest[], host: string) {
    if (!subRequests || !host) {
        throw new Error(
            'Missing required parameters: batch build requires sub requests and host',
        );
    }

    const body = [];
    let boundary = '--+';

    for (let i = 0, l = subRequests.length; i < l; i++) {
        const request = subRequests[i];
        if (
            request.data &&
            request.data.substr(0, boundary.length) === boundary
        ) {
            const nextCharacter =
                request.data.substr(boundary.length, 1) === '+' ? '-' : '+';
            boundary += nextCharacter;
        }
    }

    for (let i = 0, l = subRequests.length; i < l; i++) {
        const request = subRequests[i];
        const method = request.method.toUpperCase();

        body.push(boundary);
        body.push('Content-Type:application/http; msgtype=request', '');

        body.push(method + ' ' + request.url + ' HTTP/1.1');
        body.push('X-Request-Id:' + getRequestId());
        if (request.headers) {
            for (const header in request.headers) {
                if (request.headers.hasOwnProperty(header)) {
                    body.push(header + ':' + request.headers[header]);
                }
            }
        }

        /* Don't care about content type for requests that have no body. */
        if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
            body.push('Content-Type:application/json; charset=utf-8');
        }

        body.push('Host:' + host, '');
        body.push(request.data || '');
    }

    body.push(boundary + '--', '');
    return {
        body: body.join('\r\n'),
        boundary: boundary.substr(2),
    };
}

export { parse, build };
