import {
  BadRequestException,
  Injectable,
  PipeTransform,
  ValidationPipe,
} from '@nestjs/common';
import type { Type } from '@nestjs/common';

// Parses a JSON-encoded form field into a validated DTO. Used on multipart
// endpoints (file upload) where the structured body has to ride along inside
// a single string field next to the file fields.
//
// The parsed object is then handed to the same ValidationPipe rules the rest
// of the app uses (whitelist + forbidNonWhitelisted + transform), so the
// JSON-string body and a JSON body get exactly the same validation behaviour.
//
// Usage:
//   @Post('upload')
//   @UseInterceptors(FilesInterceptor('files', MAX_TOUR_IMAGE_FILES, imageUploadOptions))
//   create(
//     @UploadedFiles() files: Express.Multer.File[],
//     @Body('data', new ParseJsonPipe(CreateTourDto)) dto: CreateTourDto,
//   ) {}
@Injectable()
export class ParseJsonPipe<T extends object> implements PipeTransform {
  private readonly validationPipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  });

  constructor(private readonly cls: Type<T>) {}

  async transform(value: unknown): Promise<T> {
    if (value === undefined || value === null || value === '') {
      throw new BadRequestException(
        'multipart body is missing the `data` JSON field',
      );
    }
    if (typeof value !== 'string') {
      throw new BadRequestException('`data` must be a JSON string');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new BadRequestException('`data` is not valid JSON');
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new BadRequestException('`data` must decode to a JSON object');
    }
    return (await this.validationPipe.transform(parsed, {
      type: 'body',
      metatype: this.cls,
    })) as T;
  }
}
