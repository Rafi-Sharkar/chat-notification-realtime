import { Injectable, NestMiddleware } from '@nestjs/common';
import chalk from 'chalk';
import { NextFunction, Request, Response } from 'express';

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return '[Unable to stringify]';
  }
}

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const startTime = Date.now();

    const { method, originalUrl, headers } = req;
    const body = req.body as unknown;
    const cookies = req.cookies as unknown;
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const contentType = headers['content-type'] || '';

    console.group(chalk.bgGreen.black.bold('📥 Incoming Request'));
    console.info(`${chalk.cyan('🔗 URL:')} ${chalk.white(originalUrl)}`);
    console.info(`${chalk.yellow('📬 Method:')} ${chalk.white(method)}`);
    console.info(`${chalk.magenta('🌐 IP:')} ${chalk.white(ip)}`);
    console.info(
      `${chalk.green('🎯 Headers:')} ${chalk.gray(safeStringify(headers))}`,
    );

    // * Handle multipart/form-data differently
    if (contentType.includes('multipart/form-data')) {
      console.info(
        `${chalk.blue('📦 Body (form-data):')} ${chalk.gray(safeStringify(body))}`,
      );

      if (req.file) {
        console.info(
          `${chalk.red('📁 Uploaded File:')} ${chalk.gray(safeStringify(req.file))}`,
        );
      }

      if (req.files) {
        console.info(
          `${chalk.red('📁 Uploaded Files:')} ${chalk.gray(safeStringify(req.files))}`,
        );
      }
    } else {
      console.info(
        `${chalk.blue('📦 Body:')} ${chalk.gray(safeStringify(body))}`,
      );
    }

    console.info(
      `${chalk.red('🍪 Cookies:')} ${chalk.gray(safeStringify(cookies))}`,
    );
    console.groupEnd();

    // * Capture response
    const oldJson = res.json.bind(res);
    res.json = (data: unknown) => {
      const duration = Date.now() - startTime;

      console.group(chalk.bgCyan.white.bold('📤 Outgoing Response'));
      console.info(`${chalk.green('📨 Status Code:')} ${res.statusCode}`);
      console.info(`${chalk.blue('🕒 Response Time:')} ${duration} ms`);
      console.info(
        `${chalk.cyan('📦 Response Body:')} ${chalk.gray(safeStringify(data))}`,
      );
      console.groupEnd();
      console.info(chalk.gray('-'.repeat(60)));

      return oldJson(data);
    };

    next();
  }
}
