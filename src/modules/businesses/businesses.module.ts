import { Module } from '@nestjs/common';
import { BusinessesController } from './businesses.controller';
import { BusinessesService } from './businesses.service';
import { BusinessCustomersController } from './customers/business-customers.controller';
import { BusinessCustomersService } from './customers/business-customers.service';
import { BusinessMembersController } from './members/business-members.controller';
import { BusinessMembersService } from './members/business-members.service';

@Module({
  controllers: [
    BusinessesController,
    BusinessMembersController,
    BusinessCustomersController,
  ],
  providers: [
    BusinessesService,
    BusinessMembersService,
    BusinessCustomersService,
  ],
  exports: [
    BusinessesService,
    BusinessMembersService,
    BusinessCustomersService,
  ],
})
export class BusinessesModule {}
