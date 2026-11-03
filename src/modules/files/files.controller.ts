import {
  Body,
  Controller,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedOnly } from '../../common/decorators/authenticated-only.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { FilePurpose } from '../../common/enums/file-purpose.enum';
import { Errors } from '../../common/errors/errors';
import { UploadFileDto } from './dto/upload-file.dto';
import { UploadedFileResponseDto } from './dto/uploaded-file-response.dto';
import { FilesService } from './files.service';

@ApiTags('Files')
@ApiBearerAuth()
@Controller('files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  // Phase one of every file attachment: upload ONE file, get its id, then send
  // that id in the JSON request of whatever it belongs to. Several files are
  // several requests, in parallel — each succeeds or fails on its own.
  //
  // `@AuthenticatedOnly`: the file lands in the caller's own staging area and
  // grants nothing until a resource the caller may edit attaches it, so there
  // is no subject to check a permission against here. Guards run before the
  // interceptor, so an anonymous request is refused before multer reads a byte.
  @Post()
  @AuthenticatedOnly()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'purpose'],
      properties: {
        file: { type: 'string', format: 'binary' },
        purpose: { type: 'string', enum: Object.values(FilePurpose) },
      },
    },
  })
  @ApiCreatedResponse({ type: UploadedFileResponseDto })
  async upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadFileDto,
    @CurrentUser() currentUser: AuthenticatedUser,
  ): Promise<UploadedFileResponseDto> {
    if (!file) {
      throw Errors.badRequest('A file is required, in the part named `file`.');
    }
    const row = await this.filesService.upload(
      file,
      dto.purpose,
      currentUser.id,
    );
    return new UploadedFileResponseDto(row);
  }
}
