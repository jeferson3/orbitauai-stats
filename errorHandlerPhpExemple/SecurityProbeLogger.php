<?php


use App\Application\App;
use Psr\Log\LoggerInterface;
use Symfony\Component\HttpFoundation\Request;

final readonly class SecurityProbeLogger
{
    private const array FILE_ACCESS_VALIDATION_ALLOWED_PATHS = [
        '/api/doc.json',
    ];

    public function __construct(
        private LoggerInterface $securityProbeLogger
    )
    {
    }

    public function isSecurityProbe(Request $request): bool
    {
        return !$this->isExpectedHost($request->getHost()) || $this->isTryingToAccessFile($request->getPathInfo());
    }

    public function log(Request $request, int $statusCode): void
    {
        $reason = !$this->isExpectedHost($request->getHost()) ? 'invalid_host' : 'file_access';

        $this->securityProbeLogger->info(
            sprintf('Blocked request: %s %s', $request->getMethod(), $request->getRequestUri()),
            [
                'reason' => $reason,
                'statusCode' => $statusCode,
                'appId' => App::getId(),
                'method' => $request->getMethod(),
                'path' => $request->getPathInfo(),
                'uri' => $request->getRequestUri(),
                'host' => $request->getHost(),
                'expectedHost' => \App\Domain\DomainService\getExpectedAppHost(),
                'ip' => App::getUserIP(),
                'userAgent' => $request->headers->get('user-agent'),
                'referer' => $request->headers->get('referer'),
            ]
        );
    }

    private function isTryingToAccessFile(string $path): bool
    {
        $path = strtolower($path);

        if ($this->isFileAccessValidationAllowedPath($path)) {
            return false;
        }

        $segments = array_filter(explode('/', trim($path, '/')));

        foreach ($segments as $segment) {
            if (str_starts_with($segment, '.')) {
                return true;
            }
        }

        $lastSegment = end($segments);

        return is_string($lastSegment) && preg_match('/\.[a-z0-9][a-z0-9_-]{0,15}$/i', $lastSegment) === 1;
    }

    private function isExpectedHost(?string $host): bool
    {
        return \App\Domain\DomainService\isExpectedAppHost($host);
    }

    private function isFileAccessValidationAllowedPath(string $path): bool
    {
        return in_array($path, self::FILE_ACCESS_VALIDATION_ALLOWED_PATHS, true);
    }
}
