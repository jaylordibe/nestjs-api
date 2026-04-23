import { IsString, MaxLength, MinLength } from 'class-validator';

export class GdprEraseDto {
  @IsString()
  @MinLength(8)
  @MaxLength(72)
  currentPassword!: string;
}
