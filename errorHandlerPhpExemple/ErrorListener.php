<?php


use App\Application\Exception\AppException;
use App\Application\Exception\HttpConnectorException;
use App\Application\Trait\CORSResponseTrait;
use App\Domain\DomainService\SecurityProbeLogger;
use Symfony\Component\DependencyInjection\ParameterBag\ParameterBagInterface;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Event\ExceptionEvent;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

final readonly class ErrorListener
{
    use CORSResponseTrait;

    public function __construct(
        private ParameterBagInterface $params,
        private SecurityProbeLogger   $securityProbeLogger
    )
    {
    }

    public function onKernelException(ExceptionEvent $event): void
    {
        $exception = $event->getThrowable();

        $statusCode = Response::HTTP_INTERNAL_SERVER_ERROR;

        if ($exception instanceof HttpExceptionInterface) {
            if ($exception->getStatusCode() === Response::HTTP_NOT_FOUND) {
                $message = AppException::NOT_FOUND_MESSAGE;
            }
            else {
                $message = AppException::MESSAGE;
            }
            $statusCode = $exception->getStatusCode();
        }
        else if (
            $exception instanceof AppException
        ) {
            if ($exception instanceof HttpConnectorException) {
                $message = json_decode($exception->getMessage());
                $statusCode = $message->exception->code;
            }
            else {
                $message = $exception->getMessage();
                $statusCode = $exception->getCode();

            }
        }
        else {
            $message = AppException::MESSAGE;
        }

        $this->logException($event, $exception, $statusCode);

        $response = \App\Application\json(messages: [$message], statusCode: $statusCode);

        $response = $this->applyCorsHeaders($response, $this->params);

        $event->setResponse($response);
    }

    private function logException(ExceptionEvent $event, \Throwable $exception, int $statusCode): void
    {
        $request = $event->getRequest();

        if ($this->securityProbeLogger->isSecurityProbe($request)) {
            $this->securityProbeLogger->log($request, $statusCode);
            return;
        }

        if ($statusCode === Response::HTTP_NOT_FOUND) {
            return;
        }

        \App\Application\log_message($exception);
    }
}
