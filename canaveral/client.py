import json
import http.client
import ssl
import urllib.error
import urllib.parse
import urllib.request

from .model import Error,identifier


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Error("Orchestrator redirects are not followed.")


class Client:
    def __init__(self, url, token, allow_http=False, ca_file=None):
        parsed = urllib.parse.urlsplit(url)
        if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise Error("Use an orchestrator origin URL without credentials, query or path.", 400)
        if not parsed.hostname or (parsed.scheme != "https" and not (parsed.scheme == "http" and (allow_http or parsed.hostname in ("127.0.0.1", "localhost", "::1")))):
            raise Error("Remote orchestrators require HTTPS; explicitly allow HTTP only on a trusted private network.", 400)
        self.url, self.token, self.allow_http = url.rstrip("/"), token, allow_http
        if ca_file is not None and parsed.scheme!='https':raise Error('A CA file requires an HTTPS origin.',400)
        self.ca_file=ca_file
        try:self.ssl_context=ssl.create_default_context(cafile=ca_file) if parsed.scheme=='https' else None
        except (OSError,ValueError,TypeError) as error:raise Error('Could not load the controller CA file.',400) from error
        self.opener = urllib.request.build_opener(NoRedirect,urllib.request.HTTPSHandler(context=self.ssl_context))

    def request(self, method, path, value=None):
        data = json.dumps(value).encode() if value is not None else None
        request = urllib.request.Request(self.url + path, data=data, method=method,
                                         headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        mutating=method.upper() not in ('GET','HEAD','OPTIONS')
        request_id=None
        if isinstance(value,dict) and 'id' in value:
            try:request_id=identifier(value['id'])
            except Error:pass
        try:
            with self.opener.open(request, timeout=20) as response:
                return json.loads(response.read(8 * 1048576))
        except urllib.error.HTTPError as error:
            metadata={}
            try:
                metadata=json.loads(error.read(4096))
                if not isinstance(metadata,dict):metadata={}
                message=metadata.get('message',metadata.get('error','Orchestrator request failed.'))
            except ValueError:
                message = "Orchestrator request failed."
            finally:
                error.close()
            raise Error(message,error.code,code=metadata.get('code'),request_id=metadata.get('requestId'),retryable=metadata.get('retryable'))
        except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException) as error:
            message=('Orchestrator response was not confirmed. Inspect the existing request before another mutation.' if mutating
                     else 'Orchestrator response was not confirmed.')
            raise Error(message,503,request_id=request_id,retryable=not mutating,
                        outcome='unknown' if mutating else None) from error
        except (ValueError,UnicodeError) as error:
            raise Error('Orchestrator returned an invalid JSON response. Inspect state before another mutation.',502,
                        code='response_invalid',request_id=request_id,retryable=False,
                        outcome='unknown' if mutating else None) from error
