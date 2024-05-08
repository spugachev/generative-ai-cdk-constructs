/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as batch from 'aws-cdk-lib/aws-batch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as aws_ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { ConstructName } from '../../../common/base-class';
import { BaseClass, BaseClassProps } from '../../../common/base-class/base-class';

export interface CrawlerTarget {
  /**
   * Target URL to be crawled.
   */
  readonly url: string;
  /**
   * Type of URL to be crawled.
   */
  readonly targetType: CrawlerTargetType;
  /**
   * Maximum number of requests to be made.
   *
   * @default - crawler limit
   */
  readonly maxRequests?: number;
  /**
   * Download files from the web site.
   *
   * @default - true
   */
  readonly downloadFiles?: boolean;
  /**
   * Maximum number of files to be downloaded.
   *
   * @default - crawler limit
   */
  readonly maxFiles?: number;
  /**
   * File types to be downloaded.
   *
   * @default - all file types
   */
  readonly fileTypes?: string[];
  /**
   * Ignore robots.txt file.
   *
   * @default - false
   */
  readonly ignoreRobotsTxt?: boolean;
  /**
   * Schedule the crawler to run every N hours.
   *
   * @default - not scheduled
   */
  readonly crawlIntervalHours?: number;
}

export interface WebCrawlerProps {
  /**
   * Value will be appended to resources name.
   *
   * @default - _dev
   */
  readonly stage?: string;
  /**
   * Optional.CDK constructs provided collects anonymous operational
   * metrics to help AWS improve the quality and features of the
   * constructs. Data collection is subject to the AWS Privacy Policy
   * (https://aws.amazon.com/privacy/). To opt out of this feature,
   * simply disable it by setting the construct property
   * "enableOperationalMetric" to false for each construct used.
   *
   * @default - true
   */
  readonly enableOperationalMetric?: boolean;
  /**
   * Enable observability. Warning: associated cost with the services
   * used. Best practice to enable by default.
   *
   * @default - true
   */
  readonly observability?: boolean;
  /**
   *  An existing VPC can be used to deploy the construct.
   *
   * @default - none
   */
  readonly existingVpc?: ec2.IVpc;
  /**
   *  Targets to be crawled.
   *
   * @default - none
   */
  readonly targets?: CrawlerTarget[];
}

export enum CrawlerTargetType {
  WEBSITE = 'website',
  RSS_FEED = 'rss_feed',
}

export class WebCrawler extends BaseClass {
  /**
   * Returns the instance of S3 bucket used by the construct
   */
  public readonly dataBucket: s3.IBucket;
  /**
   * Returns the instance of SNS Topic used by the construct
   */
  public readonly snsTopic: sns.ITopic;
  /**
   * Returns the instance of Targets DynamoDB table
   */
  public readonly targetsTable: dynamodb.ITable;
  /**
   * Returns the instance of Jobs DynamoDB table
   */
  public readonly jobsTable: dynamodb.ITable;
  /**
   * Returns the instance of JobQueue used by the construct
   */
  public readonly jobQueue: batch.IJobQueue;
  /**
   * Returns the instance of JobDefinition used by the construct
   */
  public readonly webCrawlerJobDefinition: batch.IJobDefinition;

  /**
   * @summary Constructs a new instance of the WebCrawler class.
   * @param {Construct} scope - represents the scope for all the resources.
   * @param {string} id - this is a a scope-unique id.
   * @param {WebCrawlerProps} props - user provided props for the construct.
   * @since 0.0.0
   * @access public
   */
  constructor(scope: Construct, id: string, props: WebCrawlerProps) {
    super(scope, id);

    const vpc =
      props.existingVpc ??
      new ec2.Vpc(this, 'webCrawlerVpc', {
        createInternetGateway: true,
        natGateways: 1,
      });

    const baseProps: BaseClassProps = {
      stage: props.stage,
      enableOperationalMetric: props.enableOperationalMetric,
      constructName: ConstructName.AWSWEBCRAWLER,
      constructId: id,
      observability: props.observability,
    };

    this.updateEnvSuffix(baseProps);
    this.addObservabilityToConstruct(baseProps);

    const targetsTable = new dynamodb.Table(this, 'targetsTable', {
      partitionKey: { name: 'target_url', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const jobsTable = new dynamodb.Table(this, 'jobsTable', {
      partitionKey: { name: 'target_url', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'job_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const dataBucket = new s3.Bucket(this, 'webCrawlerDataBucket', {
      accessControl: s3.BucketAccessControl.PRIVATE,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    const snsTopic = new sns.Topic(this, 'webCrawlerTopic');

    const computeEnvironment = new batch.FargateComputeEnvironment(this, 'webCrawlerEnvironment', {
      vpc,
      maxvCpus: 8,
      replaceComputeEnvironment: true,
      updateTimeout: cdk.Duration.minutes(30),
      updateToLatestImageVersion: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    const jobQueue = new batch.JobQueue(this, 'webCrawlerJobQueue', {
      computeEnvironments: [
        {
          computeEnvironment,
          order: 1,
        },
      ],
      priority: 1,
    });

    const webCrawlerJobRole = new iam.Role(this, 'webCrawlerJobRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')],
    });

    const webCrawlerContainer = new batch.EcsFargateContainerDefinition(this, 'webCrawlerContainer', {
      cpu: 2,
      memory: cdk.Size.mebibytes(4096),
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '../../../../resources/gen-ai/aws-web-crawler-image'), {
        platform: aws_ecr_assets.Platform.LINUX_AMD64,
      }),
      jobRole: webCrawlerJobRole,
      environment: {
        AWS_DEFAULT_REGION: cdk.Stack.of(this).region,
        TARGETS_TABLE_NAME: targetsTable.tableName,
        JOBS_TABLE_NAME: jobsTable.tableName,
        DATA_BUCKET_NAME: dataBucket.bucketName,
        SNS_TOPIC_ARN: snsTopic.topicArn,
      },
    });

    targetsTable.grantReadWriteData(webCrawlerJobRole);
    jobsTable.grantReadWriteData(webCrawlerJobRole);
    dataBucket.grantReadWrite(webCrawlerJobRole);
    snsTopic.grantPublish(webCrawlerJobRole);

    const webCrawlerJobDefinition = new batch.EcsJobDefinition(this, 'webCrawlerJob', {
      container: webCrawlerContainer,
      retryAttempts: 1,
      timeout: cdk.Duration.hours(24),
      retryStrategies: [
        batch.RetryStrategy.of(batch.Action.EXIT, batch.Reason.CANNOT_PULL_CONTAINER),
        batch.RetryStrategy.of(
          batch.Action.EXIT,
          batch.Reason.custom({
            onExitCode: '137',
          }),
        ),
      ],
    });

    for (const target of props.targets ?? []) {
      let targetUrl = target.url.trim();
      if (!/^https?:\/\//.test(targetUrl.toLowerCase())) {
        targetUrl = `https://${targetUrl}`;
      }

      new cr.AwsCustomResource(this, `target-${targetUrl}`, {
        onCreate: {
          service: 'DynamoDB',
          action: 'putItem',
          parameters: {
            TableName: targetsTable.tableArn,
            Item: {
              target_url: { S: targetUrl },
              target_type: { S: target.targetType },
              sitemaps: { L: [] },
              max_requests: { N: `${target.maxRequests ?? 0}` },
              max_files: { N: `${target.maxFiles ?? 0}` },
              download_files: { BOOL: target.downloadFiles ?? true },
              file_types: { L: target.fileTypes ?? [] },
              ignore_robots_txt: { BOOL: target.ignoreRobotsTxt ?? false },
              crawl_interval_hours: { N: `${target.crawlIntervalHours ?? 0}` },
              last_finished_job_id: { S: '' },
              created_at: { N: `${Date.now()}` },
              updated_at: { N: `${Date.now()}` },
            },
          },
          physicalResourceId: cr.PhysicalResourceId.of(targetUrl),
        },
        onUpdate: {
          service: 'DynamoDB',
          action: 'putItem',
          parameters: {
            TableName: targetsTable.tableArn,
            Item: {
              target_url: { S: targetUrl },
              target_type: { S: target.targetType },
              sitemaps: { L: [] },
              max_requests: { N: `${target.maxRequests ?? 0}` },
              max_files: { N: `${target.maxFiles ?? 0}` },
              download_files: { BOOL: target.downloadFiles ?? true },
              file_types: { L: target.fileTypes ?? [] },
              ignore_robots_txt: { BOOL: target.ignoreRobotsTxt ?? false },
              crawl_interval_hours: { N: `${target.crawlIntervalHours ?? 0}` },
            },
          },
        },
        onDelete: {
          service: 'DynamoDB',
          action: 'deleteItem',
          parameters: {
            TableName: targetsTable.tableArn,
            Key: {
              target_url: { S: targetUrl },
            },
          },
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem'],
            resources: [targetsTable.tableArn],
          }),
        ]),
      });
    }

    const schedulerFunction = new lambda.Function(this, 'webCrawlerSchedulerFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'lambda.handler',
      timeout: cdk.Duration.minutes(15),
      memorySize: 256,
      code: lambda.Code.fromAsset(path.join(__dirname, '../../../../lambda/aws-web-crawler-scheduler')),
      logGroup: new logs.LogGroup(this, 'webCrawlerSchedulerLogGroup', { retention: logs.RetentionDays.ONE_WEEK }),
      environment: {
        TARGETS_TABLE_NAME: targetsTable.tableName,
        JOBS_TABLE_NAME: jobsTable.tableName,
        JOB_QUEUE_ARN: jobQueue.jobQueueArn,
        JOB_DEFINITION_ARN: webCrawlerJobDefinition.jobDefinitionArn,
      },
    });

    targetsTable.grantReadWriteData(schedulerFunction);
    jobsTable.grantReadWriteData(schedulerFunction);
    schedulerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['batch:SubmitJob'],
        resources: [webCrawlerJobDefinition.jobDefinitionArn, jobQueue.jobQueueArn],
      }),
    );

    const rule = new events.Rule(this, 'webCrawlerSchedulerRule', {
      schedule: events.Schedule.expression('cron(0/15 * * * ? *)'),
    });

    rule.addTarget(new targets.LambdaFunction(schedulerFunction));

    this.dataBucket = dataBucket;
    this.snsTopic = snsTopic;
    this.targetsTable = targetsTable;
    this.jobsTable = jobsTable;
    this.jobQueue = jobQueue;
    this.webCrawlerJobDefinition = webCrawlerJobDefinition;
  }
}